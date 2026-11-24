//! One Sonus Connect connection (connect.md, Connecting): JSON text frames of at most 1 MiB; `hello` first; a ping
//! every 30 s and the connection closed after 75 s of silence; a close with code 1000 or 1001 is a goodbye, anything
//! else a network loss.
//!
//! Two tasks per connection: this one reads, and hands each message to the user's room in the order it came; the
//! writer sends what the room puts into the connection's outbox, and the pings.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::error::{CapacityError, Error};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};
use tracing::debug;

use super::{Frame, Inner, Link, OUTBOX, Refused, Room, close, store};
use crate::subsonic::SignedIn;

/// A frame that cannot be written for this long: the device is gone.
const WRITE_WITHIN: Duration = Duration::from_secs(30);
/// After the server's close frame, the device's own is waited for this long before the connection is cut.
const CLOSE_WITHIN: Duration = Duration::from_secs(2);

/// How the reading ended.
enum End {
    /// The device closed with this code (1005: without one).
    Closed(u16),
    /// The connection broke, or was silent too long.
    Lost,
    /// The server closed it (a close frame is in the outbox, or on its way).
    ByServer,
}

pub(super) async fn run<S>(inner: Arc<Inner>, user: SignedIn, ws: WebSocketStream<S>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, stream) = ws.split();
    let attached = {
        let (inner, user) = (inner.clone(), SignedIn { user_id: user.user_id.clone(), user_name: user.user_name.clone() });
        tokio::task::spawn_blocking(move || inner.attach(&user)).await
    };
    let room = match attached {
        Ok(Ok(room)) => room,
        refused => {
            let (code, reason) = match refused {
                Ok(Err(Refused::TooMany)) => (close::TRY_AGAIN_LATER, "too many connections"),
                Ok(Err(Refused::Stopping)) => (close::GOING_AWAY, "the server is stopping"),
                _ => (close::INTERNAL, "the session could not be read"),
            };
            let _ = tokio::time::timeout(CLOSE_WITHIN, sink.send(Message::Close(Some(CloseFrame { code: code.into(), reason: reason.into() })))).await;
            return;
        }
    };

    let (tx, rx) = mpsc::channel::<Frame>(OUTBOX);
    let link = Link { connection: inner.connection_id(), tx, kill: Arc::new(Notify::new()) };
    let writer = tokio::spawn(write(sink, rx, link.kill.clone(), inner.setup.ping_every));

    let mut reader = Reader { inner: inner.clone(), room: room.clone(), user, link, device: None, stream };
    let end = reader.read().await;
    let Reader { link, device, mut stream, user, .. } = reader;

    // the session hears of it first: the device left, or its connection was lost
    if let Some(id) = &device {
        let goodbye = matches!(end, End::Closed(1000 | 1001));
        let (inner, room, id, connection) = (inner.clone(), room.clone(), id.clone(), link.connection);
        let _ = tokio::task::spawn_blocking(move || inner.gone(&room, &id, connection, goodbye)).await;
    }
    {
        let (inner, room, said_hello) = (inner.clone(), room.clone(), device.is_some());
        let _ = tokio::task::spawn_blocking(move || inner.detach(&room, said_hello)).await;
    }
    debug!(user = %user.user_name, device = device.as_deref().unwrap_or("(no hello)"), "Connect: disconnected");

    if matches!(end, End::ByServer) {
        // the close frame goes out, and the device's answer is read, so the frame is not lost with the connection
        let _ = tokio::time::timeout(CLOSE_WITHIN, async {
            link.kill.notified().await;
            while let Some(Ok(message)) = stream.next().await {
                if message.is_close() {
                    break;
                }
            }
        })
        .await;
    }
    // with the last sender gone the writer writes what is left (the answer to the device's close), and ends
    drop(link);
    let mut writer = writer;
    if tokio::time::timeout(CLOSE_WITHIN, &mut writer).await.is_err() {
        writer.abort();
    }
}

struct Reader<S> {
    inner: Arc<Inner>,
    room: Arc<Room>,
    user: SignedIn,
    link: Link,
    /// The device this connection is, once it said hello.
    device: Option<String>,
    stream: SplitStream<WebSocketStream<S>>,
}

impl<S> Reader<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    fn close(&self, code: u16, reason: &'static str) -> End {
        self.link.close(code, reason);
        End::ByServer
    }

    async fn read(&mut self) -> End {
        let inner = self.inner.clone();
        let setup = &inner.setup;
        let (silence, hello_within, check_every) = (setup.silence, setup.hello_within, setup.user_check_every);
        let opened = Instant::now();
        let mut heard = opened;
        let mut user_check = tokio::time::interval_at(opened + check_every, check_every);
        user_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let mut deadline = heard + silence;
            if self.device.is_none() {
                deadline = deadline.min(opened + hello_within);
            }
            let message = tokio::select! {
                // the room gave up on this connection (it does not read), or the writer ended
                () = self.link.kill.notified() => {
                    self.link.kill.notify_one(); // for whoever waits for it after this
                    return End::ByServer;
                }
                _ = user_check.tick() => {
                    let (db, user_id) = (setup.db.clone(), self.user.user_id.clone());
                    let exists = tokio::task::spawn_blocking(move || store::user_exists(&db, &user_id)).await;
                    if matches!(exists, Ok(Ok(false))) {
                        return self.close(close::POLICY, "the user is gone");
                    }
                    continue;
                }
                next = tokio::time::timeout_at(deadline, self.stream.next()) => match next {
                    Err(_) if self.device.is_none() && Instant::now() >= opened + hello_within => return self.close(close::POLICY, "hello expected"),
                    Err(_) => return End::Lost, // silent for too long
                    Ok(None) => return End::Lost,
                    Ok(Some(Err(Error::Capacity(CapacityError::MessageTooLong { .. })))) => return self.close(close::TOO_BIG, "a message is at most 1 MiB"),
                    Ok(Some(Err(_))) => return End::Lost,
                    Ok(Some(Ok(message))) => message,
                },
            };
            heard = Instant::now();
            match message {
                Message::Text(text) => {
                    if let Some(end) = self.message(text).await {
                        return end;
                    }
                }
                // the library queued the pong: the writer sends it
                Message::Ping(_) => {
                    let _ = self.link.tx.try_send(Frame::Flush);
                }
                Message::Close(frame) => return End::Closed(frame.map(|f| u16::from(f.code)).unwrap_or(1005)),
                Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
    }

    /// A text frame. Some: the connection ends.
    async fn message(&mut self, text: Utf8Bytes) -> Option<End> {
        let (inner, room, link, device) = (self.inner.clone(), self.room.clone(), self.link.clone(), self.device.clone());
        let handled = tokio::task::spawn_blocking(move || {
            // what is not JSON is not a message
            let Ok(msg) = serde_json::from_str::<Value>(text.as_str()) else { return Handled::Ignored };
            match device {
                None => match inner.hello(&room, &link, &msg) {
                    Some(id) => Handled::Hello(id),
                    None => Handled::Refused,
                },
                Some(id) => match inner.message(&room, &id, link.connection, &msg) {
                    true => Handled::Ignored,
                    false => Handled::Replaced,
                },
            }
        })
        .await;
        match handled {
            Ok(Handled::Ignored) => None,
            Ok(Handled::Hello(id)) => {
                debug!(user = %self.user.user_name, device = %id, "Connect: connected");
                self.device = Some(id);
                None
            }
            // the error is in the outbox already
            Ok(Handled::Refused) => Some(self.close(close::POLICY, "hello expected")),
            // a newer connection is this device now; its close frame (4000) is in the outbox
            Ok(Handled::Replaced) => Some(End::ByServer),
            Err(_) => Some(self.close(close::INTERNAL, "internal error")),
        }
    }
}

enum Handled {
    Ignored,
    Hello(String),
    Refused,
    Replaced,
}

/// Writes the outbox and the pings. Ends when the outbox closes, after a close frame, or when a write fails or
/// takes too long; `kill` then tells the reader.
async fn write<S>(mut sink: SplitSink<WebSocketStream<S>, Message>, mut outbox: mpsc::Receiver<Frame>, kill: Arc<Notify>, ping_every: Duration)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut ping = tokio::time::interval_at(Instant::now() + ping_every, ping_every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let message = tokio::select! {
            frame = outbox.recv() => match frame {
                None => break,
                Some(Frame::Text(text)) => Message::Text(text),
                Some(Frame::Flush) => {
                    if !matches!(tokio::time::timeout(WRITE_WITHIN, sink.flush()).await, Ok(Ok(()))) {
                        break;
                    }
                    continue;
                }
                Some(Frame::Close(code, reason)) => {
                    let frame = CloseFrame { code: code.into(), reason: reason.into() };
                    let _ = tokio::time::timeout(WRITE_WITHIN, sink.send(Message::Close(Some(frame)))).await;
                    break;
                }
            },
            _ = ping.tick() => Message::Ping(Bytes::new()),
        };
        if !matches!(tokio::time::timeout(WRITE_WITHIN, sink.send(message)).await, Ok(Ok(()))) {
            break;
        }
    }
    kill.notify_one();
    let _ = tokio::time::timeout(Duration::from_secs(2), sink.flush()).await;
}
