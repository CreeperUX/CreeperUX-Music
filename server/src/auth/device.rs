//! The browser sign-in for apps (the fork's `server/sonus_device.go`), as OAuth's device authorization grant
//! (RFC 8628) has it. The app asks for a sign-in and gets a device code it keeps, and a short user code to show; it
//! opens the approval page in the browser, where the user signs in and, seeing the same code as in the app, allows
//! it. The app, polling meanwhile with its device code, then gets an API key: an app password made for it. The app
//! never sees the account password.
//!
//! Sign-ins that wait are kept here, in memory: a restart only means asking again. At most 200 wait at a time, each
//! for ten minutes.
//!
//! Ported from the CreeperUX fork of Navidrome (GPL-3.0).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::id;

pub const LIFETIME: Duration = Duration::from_secs(600);
/// Seconds between an app's polls.
pub const INTERVAL: u64 = 2;
const MAX_WAITING: usize = 200;

#[derive(Debug, Clone, PartialEq)]
enum State {
    Pending,
    Approved { api_key: String, username: String },
    Denied,
}

#[derive(Debug, Clone)]
struct Login {
    user_code: String,
    client: String,
    device: String,
    created: Instant,
    state: State,
}

#[derive(Default)]
pub struct DeviceLogins {
    /// By device code.
    waiting: Mutex<HashMap<String, Login>>,
}

/// What an app gets when it asks to sign in.
#[derive(Debug, PartialEq)]
pub struct Started {
    pub device_code: String,
    pub user_code: String,
}

#[derive(Debug, PartialEq)]
pub enum Poll {
    Pending,
    /// Handed over once: the sign-in is forgotten with this answer.
    Approved {
        api_key: String,
        username: String,
    },
    Denied,
    /// Unknown, expired, or handed over already.
    Expired,
}

/// What the approval page shows.
#[derive(Debug, PartialEq)]
pub struct Info {
    pub user_code: String,
    pub client: String,
    pub device: String,
    pub expires_in: u64,
}

#[derive(Debug, PartialEq)]
pub enum StartError {
    TooMany,
    Random,
}

/// The code as typed: any case, with or without its dash. None: not eight characters.
fn normal_user_code(code: &str) -> Option<String> {
    let c: String = code.chars().filter(|c| *c != '-' && *c != ' ').flat_map(char::to_uppercase).collect();
    if c.len() != 8 || !c.is_ascii() {
        return None;
    }
    Some(format!("{}-{}", &c[..4], &c[4..]))
}

/// Trimmed, and cut to `n` characters.
fn clip(text: &str, n: usize) -> String {
    text.trim().chars().take(n).collect()
}

impl DeviceLogins {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Login>> {
        let mut waiting = self.waiting.lock().expect("the device sign-ins' lock");
        waiting.retain(|_, login| login.created.elapsed() <= LIFETIME);
        waiting
    }

    /// An app asks to sign in, naming itself and its device.
    pub fn start(&self, client: &str, device: &str) -> Result<Started, StartError> {
        let device_code = id::random_hex(32).map_err(|_| StartError::Random)?;
        let mut waiting = self.lock();
        if waiting.len() >= MAX_WAITING {
            return Err(StartError::TooMany);
        }
        let user_code = loop {
            let code = id::user_code().map_err(|_| StartError::Random)?;
            if !waiting.values().any(|login| login.user_code == code) {
                break code;
            }
        };
        let client = match clip(client, 40) {
            empty if empty.is_empty() => "App".to_string(),
            client => client,
        };
        let login = Login { user_code: user_code.clone(), client, device: clip(device, 64), created: Instant::now(), state: State::Pending };
        waiting.insert(device_code.clone(), login);
        Ok(Started { device_code, user_code })
    }

    /// The app asks how its sign-in stands.
    pub fn poll(&self, device_code: &str) -> Poll {
        let mut waiting = self.lock();
        match waiting.get(device_code).map(|login| login.state.clone()) {
            None => Poll::Expired,
            Some(State::Pending) => Poll::Pending,
            Some(State::Denied) => {
                waiting.remove(device_code);
                Poll::Denied
            }
            Some(State::Approved { api_key, username }) => {
                waiting.remove(device_code);
                Poll::Approved { api_key, username }
            }
        }
    }

    /// The sign-in that waits under a user code, for the approval page.
    pub fn info(&self, user_code: &str) -> Option<Info> {
        let code = normal_user_code(user_code)?;
        let waiting = self.lock();
        let login = waiting.values().find(|login| login.user_code == code && login.state == State::Pending)?;
        Some(Info {
            user_code: login.user_code.clone(),
            client: login.client.clone(),
            device: login.device.clone(),
            expires_in: LIFETIME.saturating_sub(login.created.elapsed()).as_secs(),
        })
    }

    /// The signed-in user refuses the app. False: no sign-in waits under this code.
    pub fn deny(&self, user_code: &str) -> bool {
        let Some(code) = normal_user_code(user_code) else { return false };
        let mut waiting = self.lock();
        match waiting.values_mut().find(|login| login.user_code == code && login.state == State::Pending) {
            Some(login) => {
                login.state = State::Denied;
                true
            }
            None => false,
        }
    }

    /// The signed-in user allows the app: `make_key` makes the API key, given the name for it (`client · device`),
    /// while the sign-in is held, so two approvals at once make one key. None: no sign-in waits under this code.
    /// Blocking when `make_key` is.
    pub fn approve<E>(&self, user_code: &str, username: &str, make_key: impl FnOnce(&str) -> Result<String, E>) -> Option<Result<(), E>> {
        let code = normal_user_code(user_code)?;
        let mut waiting = self.lock();
        let login = waiting.values_mut().find(|login| login.user_code == code && login.state == State::Pending)?;
        let name = if login.device.is_empty() { login.client.clone() } else { format!("{} · {}", login.client, login.device) };
        Some(make_key(&name).map(|api_key| {
            login.state = State::Approved { api_key, username: username.to_string() };
        }))
    }

    #[cfg(test)]
    fn age(&self, device_code: &str, by: Duration) {
        let mut waiting = self.waiting.lock().unwrap();
        let login = waiting.get_mut(device_code).unwrap();
        login.created = login.created.checked_sub(by).expect("the clock has run that long");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(name: &str) -> Result<String, ()> {
        Ok(format!("key for {name}"))
    }

    #[test]
    fn the_app_gets_its_key_once_its_user_allows_it_only_once() {
        let logins = DeviceLogins::default();
        let s = logins.start(" Sonus ", "书房电脑").unwrap();
        assert_eq!(s.device_code.len(), 64);
        assert_eq!(logins.poll(&s.device_code), Poll::Pending);
        let info = logins.info(&s.user_code.to_lowercase()).unwrap();
        assert_eq!((info.user_code.as_str(), info.client.as_str(), info.device.as_str()), (s.user_code.as_str(), "Sonus", "书房电脑"));
        assert!(info.expires_in > 590 && info.expires_in <= 600);
        assert_eq!(logins.approve(&s.user_code, "alice", key), Some(Ok(())));
        assert_eq!(logins.info(&s.user_code), None, "decided: the page has nothing to show any more");
        assert_eq!(logins.poll(&s.device_code), Poll::Approved { api_key: "key for Sonus · 书房电脑".into(), username: "alice".into() });
        assert_eq!(logins.poll(&s.device_code), Poll::Expired, "handed over once");
    }

    #[test]
    fn a_refusal_reaches_the_app_and_cannot_be_turned_into_an_approval() {
        let logins = DeviceLogins::default();
        let s = logins.start("Sonus", "").unwrap();
        assert!(logins.deny(&s.user_code.replace('-', "")), "the code without its dash");
        assert_eq!(logins.approve(&s.user_code, "alice", key), None);
        assert!(!logins.deny(&s.user_code));
        assert_eq!(logins.poll(&s.device_code), Poll::Denied);
        assert_eq!(logins.poll(&s.device_code), Poll::Expired);
    }

    #[test]
    fn a_key_that_cannot_be_made_leaves_the_sign_in_waiting() {
        let logins = DeviceLogins::default();
        let s = logins.start("", "").unwrap();
        assert_eq!(logins.approve(&s.user_code, "alice", |name| Err::<String, _>(name.to_string())), Some(Err("App".to_string())), "no name: App");
        assert_eq!(logins.poll(&s.device_code), Poll::Pending);
        assert_eq!(logins.approve(&s.user_code, "alice", key), Some(Ok(())));
    }

    #[test]
    fn sign_ins_are_forgotten_after_ten_minutes() {
        let logins = DeviceLogins::default();
        let s = logins.start("Sonus", "PC").unwrap();
        logins.age(&s.device_code, Duration::from_secs(601));
        assert_eq!(logins.poll(&s.device_code), Poll::Expired);
        assert_eq!(logins.info(&s.user_code), None);
        assert_eq!(logins.approve(&s.user_code, "alice", key), None);
    }

    #[test]
    fn at_most_two_hundred_wait_and_names_are_cut() {
        let logins = DeviceLogins::default();
        let mut codes = std::collections::HashSet::new();
        for _ in 0..200 {
            assert!(codes.insert(logins.start("Sonus", "PC").unwrap().user_code), "no user code twice");
        }
        assert_eq!(logins.start("Sonus", "PC"), Err(StartError::TooMany));
        let logins = DeviceLogins::default();
        let s = logins.start(&"c".repeat(100), &"设".repeat(100)).unwrap();
        let info = logins.info(&s.user_code).unwrap();
        assert_eq!((info.client.chars().count(), info.device.chars().count()), (40, 64));
    }

    #[test]
    fn user_codes_are_read_as_typed() {
        assert_eq!(normal_user_code("bcdf-ghjk").as_deref(), Some("BCDF-GHJK"));
        assert_eq!(normal_user_code(" BCDFGHJK ").as_deref(), Some("BCDF-GHJK"));
        assert_eq!(normal_user_code("BCDF-GHJ"), None);
        assert_eq!(normal_user_code("BCDF-GHJKL"), None);
        assert_eq!(normal_user_code(""), None);
        assert_eq!(DeviceLogins::default().info("BCDF-GHJK"), None);
    }
}
