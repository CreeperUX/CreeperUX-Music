//! Every log line of the test binary, at every level (the HTTP library's too), kept to be searched: what must never be
//! logged (a key, a signature, a presigned link) is looked for in it.

use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

static LOGS: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();

/// Starts keeping the binary's log lines (once); what was logged so far is in `text()`.
pub fn capture() {
    LOGS.get_or_init(|| {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let buffer = Buffer(logs.clone());
        let subscriber = tracing_subscriber::fmt().with_max_level(tracing::Level::TRACE).with_ansi(false).with_writer(move || buffer.clone()).finish();
        tracing::subscriber::set_global_default(subscriber).expect("one subscriber for the test binary");
        logs
    });
}

pub fn text() -> String {
    String::from_utf8_lossy(&LOGS.get().expect("capture() first").lock().unwrap()).into_owned()
}

/// Panics when the log has any of these.
pub fn assert_none_of(secrets: &[&str]) {
    let text = text();
    assert!(!text.is_empty(), "something was logged");
    for secret in secrets {
        assert!(!text.contains(secret), "the log has {secret:?}");
    }
}
