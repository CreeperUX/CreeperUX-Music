//! Replays the protocol's test vectors (`docs/protocol/connect-vectors.json`, made from the reference implementation,
//! `tools/demo-server/connect-session.mjs`): after every step the session, the queue, the device list and the direct
//! replies must be exactly what the file says.

use std::collections::HashMap;

use serde_json::{Value, json};
use sonus_server::connect::queue::{Library, Song};
use sonus_server::connect::session::{ConnectSession, Env, MAX_DEVICES, Out};

struct Vectors(HashMap<String, Song>);

impl Library for Vectors {
    fn has(&self, id: &str) -> bool {
        self.0.contains_key(id)
    }

    fn lookup(&self, id: &str) -> Option<Song> {
        self.0.get(id).cloned()
    }
}

fn library(file: &Value) -> Vectors {
    let text = |song: &Value, name: &str| song.get(name).and_then(Value::as_str).map(str::to_string);
    Vectors(
        file["library"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, song)| {
                let song = Song {
                    title: text(song, "title"),
                    artist: text(song, "artist"),
                    album: text(song, "album"),
                    album_id: text(song, "albumId"),
                    cover_art: text(song, "coverArt"),
                    duration_ms: song.get("durationMs").and_then(Value::as_i64),
                };
                (id.clone(), song)
            })
            .collect(),
    )
}

/// What the file lists as `replies`: everything sent that is not a broadcast of welcome, session, queue or devices.
fn replies(out: &[Out]) -> Value {
    let direct = out.iter().filter_map(|o| match o {
        Out::Close { id, code, .. } => Some(json!({ "close": id, "code": code })),
        Out::Reply(reply) => Some(json!({ "reply": reply })),
        Out::To { to, msg } => {
            let broadcast = matches!(msg.get("type").and_then(Value::as_str), Some("welcome" | "session" | "queue" | "devices"));
            (!broadcast).then(|| json!({ "to": to, "msg": **msg }))
        }
    });
    Value::Array(direct.collect())
}

#[test]
fn the_vectors_replay_exactly() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/protocol/connect-vectors.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let library = library(&file);
    let grace_ms = file["about"]["graceMs"].as_i64().unwrap();
    let (mut cases, mut steps) = (0, 0);
    for case in file["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // the case's random numbers in turn, each modulo n; then 0s
        let numbers: Vec<i64> = case["random"].as_array().unwrap().iter().map(|n| n.as_i64().unwrap()).collect();
        let mut drawn = 0;
        let mut random = |n: usize| match numbers.get(drawn) {
            Some(value) => {
                drawn += 1;
                value.rem_euclid(n as i64) as usize
            }
            None => 0,
        };
        let mut session = ConnectSession::new(grace_ms, MAX_DEVICES);
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let mut env = Env { now: step["at"].as_i64().unwrap(), random: &mut random, library: &library };
            let out = if let Some(device) = step.get("drop").and_then(Value::as_str) {
                session.drop_device(&mut env, device)
            } else if let Some(device) = step.get("leave").and_then(Value::as_str) {
                session.leave(&mut env, device)
            } else if step.get("tick").is_some() {
                session.tick(&mut env)
            } else if step["send"]["type"] == "hello" {
                session.hello(&mut env, &step["send"]).1
            } else {
                session.message(&mut env, step["from"].as_str().unwrap(), &step["send"])
            };
            let devices: Vec<Value> = session.device_list().as_array().unwrap().iter().map(|d| d["id"].clone()).collect();
            let got = json!({ "session": session.session(), "queue": session.queue_view(), "devices": devices, "replies": replies(&out) });
            let expect = &step["expect"];
            for part in ["session", "queue", "devices", "replies"] {
                assert_eq!(got[part], expect[part], "case “{name}”, step {i} ({}): {part}", step.get("send").unwrap_or(step));
            }
            steps += 1;
        }
        cases += 1;
    }
    assert_eq!((cases, steps), (15, 172), "the whole file");
}

/// What production showed (Windows 0.6.0, two PCs): after a gapless change the active device's engine reported
/// `loaded` with the previous song's duration, and every position of the new, longer song was held at it.
#[test]
fn a_loaded_with_the_previous_songs_duration_neither_changes_the_duration_nor_holds_the_position() {
    let song = |ms: i64| Song { title: Some("x".into()), artist: None, album: None, album_id: None, cover_art: None, duration_ms: Some(ms) };
    let library = Vectors(HashMap::from([("short".to_string(), song(230_000)), ("long".to_string(), song(285_000))]));
    let mut random = |_: usize| 0;
    let mut session = ConnectSession::new(10_000, MAX_DEVICES);
    macro_rules! at {
        ($now:expr) => {
            Env { now: $now, random: &mut random, library: &library }
        };
    }
    let hello = json!({ "type": "hello", "deviceId": "pc-study-01", "name": "PC", "kind": "desktop", "canPlay": true, "client": "test" });
    session.hello(&mut at!(0), &hello);
    let play = json!({ "type": "command", "action": "playContext", "ids": ["short", "long"], "startId": "short" });
    session.message(&mut at!(1_000), "pc-study-01", &play);
    let report = |session: &ConnectSession, event: &str, fields: Value| {
        let mut r = json!({ "type": "report", "event": event, "key": session.session()["current"]["key"], "rev": session.session()["rev"] });
        r.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        r
    };
    let r = report(&session, "playing", json!({ "positionMs": 0 }));
    session.message(&mut at!(1_100), "pc-study-01", &r);
    // the end of the first song: the device goes on to the second at once, and its engine still says 230 s
    let r = report(&session, "ended", json!({ "positionMs": 230_000 }));
    session.message(&mut at!(231_100), "pc-study-01", &r);
    assert_eq!(session.session()["current"]["trackId"], "long");
    assert_eq!(session.session()["durationMs"], 285_000);
    let r = report(&session, "loaded", json!({ "positionMs": 0, "durationMs": 230_000 }));
    session.message(&mut at!(231_200), "pc-study-01", &r);
    assert_eq!(session.session()["durationMs"], 285_000, "the library's duration stands");
    let r = report(&session, "position", json!({ "positionMs": 240_000 }));
    session.message(&mut at!(471_200), "pc-study-01", &r);
    assert_eq!(session.session()["positionMs"], 240_000, "not held at the previous song's 230 s");
    assert_eq!(session.position_at(511_200), 280_000, "and it moves on");
    // the file is a little longer than the library says: the device's position is taken, and held there at most
    let r = report(&session, "position", json!({ "positionMs": 286_500 }));
    session.message(&mut at!(517_700), "pc-study-01", &r);
    assert_eq!(session.session()["positionMs"], 286_500);
    assert_eq!(session.position_at(530_000), 286_500);
    // a remote's seek stays within the library's duration
    let seek = json!({ "type": "command", "action": "seek", "positionMs": 400_000 });
    session.message(&mut at!(518_000), "pc-study-01", &seek);
    assert_eq!(session.session()["positionMs"], 285_000);
}
