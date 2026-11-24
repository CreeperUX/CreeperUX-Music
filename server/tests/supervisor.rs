//! The real `sonus-server` binary running a fake Navidrome: what Navidrome is told, and what happens when it stops.
//!
//! The fake Navidrome is this test binary, started again by the gateway with `FAKE_NAVIDROME_OUT` set: then
//! `fake_navidrome` below plays Navidrome (records what it got, answers HTTP on its port, exits when told) and every
//! other test returns at once.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const OUT: &str = "FAKE_NAVIDROME_OUT";

fn as_fake_navidrome() -> bool {
    std::env::var_os(OUT).is_some()
}

#[test]
fn fake_navidrome() {
    let Some(out) = std::env::var_os(OUT) else { return };
    // what it was started with: its ND_ variables and its arguments
    let mut record = String::new();
    let mut vars: Vec<(String, String)> = std::env::vars().filter(|(k, _)| k.starts_with("ND_") || k == "PORT").collect();
    vars.sort();
    for (key, value) in vars {
        record.push_str(&format!("{key}={value}\n"));
    }
    std::fs::write(PathBuf::from(&out).with_extension("tmp"), record).unwrap();
    std::fs::rename(PathBuf::from(&out).with_extension("tmp"), &out).unwrap();

    if let Ok(code) = std::env::var("FAKE_NAVIDROME_EXIT") {
        std::process::exit(code.parse().unwrap());
    }
    // Navidrome's server: answers with the request's headers, until asked to stop
    let address = format!("{}:{}", std::env::var("ND_ADDRESS").unwrap(), std::env::var("ND_PORT").unwrap());
    let listener = TcpListener::bind(address).unwrap();
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(60));
        std::process::exit(99); // never outlive a test that failed
    });
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                break;
            }
            head.push_str(&line);
        }
        let body = head.to_ascii_lowercase();
        let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        stream.write_all(reply.as_bytes()).unwrap();
        drop(stream);
        if head.starts_with("GET /exit/") {
            let code: i32 = head["GET /exit/".len()..].split(' ').next().unwrap().parse().unwrap();
            std::process::exit(code);
        }
    }
}

/// A port free on 127.0.0.1 now.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Run {
    dir: PathBuf,
    gateway: Child,
    port: u16,
}

impl Run {
    /// Starts the gateway in a new folder holding `toml` as its config file (`ND_CONFIGFILE`), with `vars` set; `{port}`
    /// in either is the port the gateway is to listen on.
    fn start(name: &str, toml: Option<&str>, vars: &[(&str, &str)]) -> Run {
        let dir = std::env::temp_dir().join(format!("sonus-server-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let port = free_port();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_sonus-server"));
        // nothing from the machine's own environment that Navidrome or the gateway would read
        for (key, _) in std::env::vars() {
            if key.starts_with("ND_") || key.starts_with("SONUS_") || key == "PORT" {
                cmd.env_remove(key);
            }
        }
        if let Some(toml) = toml {
            std::fs::write(dir.join("navidrome.toml"), toml.replace("{port}", &port.to_string())).unwrap();
            cmd.env("ND_CONFIGFILE", dir.join("navidrome.toml"));
        }
        cmd.current_dir(&dir)
            .env(OUT, dir.join("navidrome.env"))
            .env("SONUS_NAVIDROME_BIN", std::env::current_exe().unwrap())
            .env("SONUS_NAVIDROME_PORT", free_port().to_string())
            .env("SONUS_LOG", "debug")
            .envs(vars.iter().map(|(k, v)| (*k, v.replace("{port}", &port.to_string()))))
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(dir.join("gateway.log")).unwrap())
            .stderr(std::fs::File::create(dir.join("gateway.err")).unwrap());
        let gateway = cmd.spawn().unwrap();
        Run { dir, gateway, port }
    }

    /// What the fake Navidrome was started with, once it has written it down.
    fn navidrome_env(&self) -> HashMap<String, String> {
        let path = self.dir.join("navidrome.env");
        let deadline = Instant::now() + Duration::from_secs(20);
        while !path.exists() {
            assert!(Instant::now() < deadline, "Navidrome was not started; the gateway said:\n{}", self.log());
            std::thread::sleep(Duration::from_millis(50));
        }
        std::fs::read_to_string(path).unwrap().lines().filter_map(|l| l.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// A GET through the gateway, retried while Navidrome is starting (503); the answer's status line and body.
    fn get(&self, path: &str, headers: &[(&str, &str)]) -> (String, String) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let answer = TcpStream::connect(("127.0.0.1", self.port)).ok().and_then(|mut stream| {
                let mut request = format!("GET {path} HTTP/1.1\r\nHost: sonus.test\r\nConnection: close\r\n");
                for (name, value) in headers {
                    request.push_str(&format!("{name}: {value}\r\n"));
                }
                request.push_str("\r\n");
                stream.write_all(request.as_bytes()).ok()?;
                let mut answer = String::new();
                stream.read_to_string(&mut answer).ok()?;
                Some(answer)
            });
            if let Some(answer) = answer.filter(|a| !a.starts_with("HTTP/1.1 503")) {
                let (head, body) = answer.split_once("\r\n\r\n").unwrap();
                return (head.lines().next().unwrap().to_string(), body.to_string());
            }
            assert!(Instant::now() < deadline, "the gateway did not answer; it said:\n{}", self.log());
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn wait(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = self.gateway.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "the gateway did not stop; it said:\n{}", self.log());
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn log(&self) -> String {
        let read = |name: &str| std::fs::read_to_string(self.dir.join(name)).unwrap_or_default();
        format!("{}{}", read("gateway.log"), read("gateway.err"))
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = self.gateway.kill();
        let _ = self.gateway.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn header_value<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    body.lines().find_map(|l| l.strip_prefix(name).and_then(|rest| rest.strip_prefix(": ")))
}

#[test]
fn navidrome_is_told_the_gateways_decisions_and_its_exit_is_the_gateways() {
    if as_fake_navidrome() {
        return;
    }
    let toml = "Address = '127.0.0.1'\nPort = {port}\n[ExtAuth]\nTrustedSources = '10.0.0.0/8'\nUserHeader = 'X-Auth-User'\n";
    let mut run = Run::start("decisions", Some(toml), &[("ND_REVERSEPROXYWHITELIST", "0.0.0.0/0"), ("ND_LOGLEVEL", "debug")]);
    let env = run.navidrome_env();
    assert_eq!(env["ND_ADDRESS"], "127.0.0.1");
    assert_ne!(env["ND_PORT"], run.port.to_string(), "Navidrome is not on the gateway's port");
    assert_eq!(env["ND_EXTAUTH_TRUSTEDSOURCES"], "127.0.0.1/32", "Navidrome trusts the gateway alone");
    assert_eq!(env["ND_EXTAUTH_USERHEADER"], "x-auth-user", "Navidrome reads the header the gateway decided on");
    assert!(!env.contains_key("ND_REVERSEPROXYWHITELIST"));
    assert_eq!(env["ND_LOGLEVEL"], "debug", "the rest of the environment is passed on");
    assert!(env["ND_CONFIGFILE"].ends_with("navidrome.toml"), "Navidrome reads the same file");

    // the gateway listens on the port from the file, and Navidrome answers behind it
    let (status, body) = run.get("/rest/ping.view?u=a", &[("X-Real-IP", "203.0.113.1"), ("X-Auth-User", "admin")]);
    assert_eq!(status, "HTTP/1.1 200 OK");
    assert_eq!(header_value(&body, "x-real-ip"), Some("127.0.0.1"), "{body}");
    assert_eq!(header_value(&body, "x-auth-user"), None, "127.0.0.1 is not a trusted proxy here: {body}");

    // Navidrome stops with 3: so does the gateway
    let _ = run.get("/exit/3", &[]);
    assert_eq!(run.wait().code(), Some(3));
}

#[test]
fn without_a_trusted_proxy_nobody_can_send_navidromes_user_header() {
    if as_fake_navidrome() {
        return;
    }
    let mut run = Run::start("no-proxy", None, &[("ND_ADDRESS", "127.0.0.1"), ("ND_PORT", "0")]);
    // ND_PORT=0 is refused: the gateway stops with 2 before starting anything
    assert_eq!(run.wait().code(), Some(2));
    assert!(!run.dir.join("navidrome.env").exists());
    assert!(run.log().contains("not a port"), "{}", run.log());
    drop(run);

    let mut run = Run::start("no-proxy", None, &[("ND_ADDRESS", "127.0.0.1"), ("ND_PORT", "{port}")]);
    let env = run.navidrome_env();
    let secret = env["ND_EXTAUTH_USERHEADER"].clone();
    assert!(secret.starts_with("x-sonus-user-"), "{secret}");
    let (status, body) = run.get("/app/", &[("Remote-User", "admin"), (&secret, "admin")]);
    assert_eq!(status, "HTTP/1.1 200 OK");
    assert_eq!(header_value(&body, &secret), None, "{body}");
    assert_eq!(header_value(&body, "remote-user"), None, "{body}");
    let _ = run.get("/exit/0", &[]);
    assert_eq!(run.wait().code(), Some(1), "Navidrome stopping by itself is a failure, even with 0");
}

#[test]
fn navidrome_that_cannot_start_stops_the_gateway() {
    if as_fake_navidrome() {
        return;
    }
    let mut run = Run::start("exit-at-once", None, &[("ND_ADDRESS", "127.0.0.1"), ("ND_PORT", "{port}"), ("FAKE_NAVIDROME_EXIT", "42")]);
    assert_eq!(run.wait().code(), Some(42));
    let mut missing = Run::start("missing-bin", None, &[("ND_ADDRESS", "127.0.0.1"), ("ND_PORT", "{port}"), ("SONUS_NAVIDROME_BIN", "/nowhere/navidrome")]);
    assert_eq!(missing.wait().code(), Some(1));
    assert!(missing.log().contains("cannot start Navidrome"), "{}", missing.log());
}
