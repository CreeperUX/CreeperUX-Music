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
    assert_eq!((cases, steps), (14, 157), "the whole file");
}
