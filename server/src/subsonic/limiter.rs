//! The failed-sign-in limiter: Navidrome's `authLimiter` (`server/subsonic/auth_limiter.go`), with the same counting.
//!
//! Failures are counted per key (the client's address with the user name, or the address alone for API keys) in
//! windows of `AuthWindowLength`, starting at the key's first attempt. A key with `AuthRequestLimit` failures in its
//! window is refused until the window is over, right credentials included, and the refusal looks like a wrong
//! password. Checks for one key run at most `limit` at a time and failures are recorded when a check ends, so a window
//! admits at most 2 × limit − 1 guesses; requests with valid credentials only ever wait.
//!
//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.

use std::collections::HashMap;
use std::hash::{BuildHasher, RandomState};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub struct Limiter {
    limit: u32,
    window: Duration,
    /// Keys are kept hashed (with a seed of this process), so names an attacker chooses cannot grow memory by their
    /// length, and idle keys are dropped once per window.
    hasher: RandomState,
    state: Mutex<State>,
}

struct State {
    keys: HashMap<u64, Attempts>,
    last_sweep: Instant,
}

struct Attempts {
    failures: u32,
    start: Instant,
    /// Checks holding or waiting for a slot: a key in use is not swept.
    refs: usize,
    slots: Arc<Semaphore>,
}

/// A credential check that may run. Tell it how the check ended with `release`; dropped without (the client went
/// away), it counts as no failure.
pub struct Slot<'a> {
    limiter: &'a Limiter,
    key: u64,
    _permit: OwnedSemaphorePermit,
    released: bool,
}

/// One reference to a key's entry, given back on drop (a request that is cancelled while it waits).
struct Ref<'a> {
    limiter: &'a Limiter,
    key: u64,
    armed: bool,
}

impl Drop for Ref<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.limiter.unref(self.key, false);
        }
    }
}

impl Limiter {
    /// None when `limit` is not positive: no limit, as in Navidrome.
    pub fn new(limit: i64, window: Duration) -> Option<Limiter> {
        let limit = u32::try_from(limit).ok().filter(|l| *l > 0)?;
        let window = if window.is_zero() { crate::config::DEFAULT_AUTH_WINDOW } else { window };
        Some(Limiter { limit, window, hasher: RandomState::new(), state: Mutex::new(State { keys: HashMap::new(), last_sweep: Instant::now() }) })
    }

    /// Reserves a check for `key`, waiting while `limit` other checks for it are running. None: the key has reached
    /// its failures for this window.
    pub async fn acquire(&self, key: &[u8]) -> Option<Slot<'_>> {
        let hash = self.hasher.hash_one(key);
        let slots = self.reserve(hash)?;
        let mut reference = Ref { limiter: self, key: hash, armed: true };
        let permit = slots.acquire_owned().await.ok()?;
        // the checks that ran meanwhile may have used the window up
        let blocked = self.lock().keys.get(&hash).is_none_or(|a| a.failures >= self.limit);
        if blocked {
            return None; // `reference` gives the entry back
        }
        reference.armed = false;
        Some(Slot { limiter: self, key: hash, _permit: permit, released: false })
    }

    fn reserve(&self, key: u64) -> Option<Arc<Semaphore>> {
        let now = Instant::now();
        let mut state = self.lock();
        self.sweep(&mut state, now);
        let attempts =
            state.keys.entry(key).or_insert_with(|| Attempts { failures: 0, start: now, refs: 0, slots: Arc::new(Semaphore::new(self.limit as usize)) });
        if now.duration_since(attempts.start) >= self.window {
            attempts.failures = 0;
            attempts.start = now;
        }
        if attempts.failures >= self.limit {
            return None;
        }
        attempts.refs += 1;
        Some(attempts.slots.clone())
    }

    fn unref(&self, key: u64, failed: bool) {
        if let Some(attempts) = self.lock().keys.get_mut(&key) {
            if failed {
                attempts.failures += 1;
            }
            attempts.refs = attempts.refs.saturating_sub(1);
        }
    }

    /// Drops idle keys whose window is over, once per window.
    fn sweep(&self, state: &mut State, now: Instant) {
        if now.duration_since(state.last_sweep) < self.window {
            return;
        }
        state.keys.retain(|_, a| a.refs > 0 || now.duration_since(a.start) < self.window);
        state.last_sweep = now;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("the limiter's lock")
    }

    #[cfg(test)]
    fn keys(&self) -> usize {
        self.lock().keys.len()
    }
}

impl Slot<'_> {
    /// The check is over: `failed` when the credentials were wrong (not when the server could not check them).
    pub fn release(mut self, failed: bool) {
        self.released = true;
        self.limiter.unref(self.key, failed);
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if !self.released {
            self.limiter.unref(self.key, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_millis(150);

    async fn fail(limiter: &Limiter, key: &[u8]) -> bool {
        match limiter.acquire(key).await {
            Some(slot) => {
                slot.release(true);
                true
            }
            None => false,
        }
    }

    #[test]
    fn no_limit_when_the_limit_is_not_positive() {
        assert!(Limiter::new(0, WINDOW).is_none());
        assert!(Limiter::new(-1, WINDOW).is_none());
        assert_eq!(Limiter::new(3, Duration::ZERO).unwrap().window, Duration::from_secs(20), "no window: Navidrome's default");
    }

    #[tokio::test]
    async fn a_key_is_refused_after_its_failures_until_the_window_is_over() {
        let limiter = Limiter::new(3, WINDOW).unwrap();
        for _ in 0..3 {
            assert!(fail(&limiter, b"ip\0alice").await);
        }
        assert!(limiter.acquire(b"ip\0alice").await.is_none(), "the fourth attempt is refused, whatever it carries");
        assert!(limiter.acquire(b"ip\0alice").await.is_none());
        assert!(limiter.acquire(b"ip\0bob").await.is_some(), "another user from the same address is not");
        assert!(limiter.acquire(b"other\0alice").await.is_some(), "nor the same user from another address");
        tokio::time::sleep(WINDOW + Duration::from_millis(30)).await;
        assert!(limiter.acquire(b"ip\0alice").await.is_some(), "a new window");
    }

    #[tokio::test]
    async fn successes_do_not_count_and_failures_are_not_forgotten_by_them() {
        let limiter = Limiter::new(2, Duration::from_secs(60)).unwrap();
        for _ in 0..10 {
            limiter.acquire(b"k").await.unwrap().release(false);
        }
        assert!(fail(&limiter, b"k").await);
        limiter.acquire(b"k").await.unwrap().release(false);
        assert!(fail(&limiter, b"k").await);
        assert!(limiter.acquire(b"k").await.is_none(), "two failures, with a success in between");
    }

    #[tokio::test]
    async fn a_dropped_slot_is_not_a_failure() {
        let limiter = Limiter::new(1, Duration::from_secs(60)).unwrap();
        drop(limiter.acquire(b"k").await.unwrap());
        drop(limiter.acquire(b"k").await.unwrap());
        assert!(fail(&limiter, b"k").await);
        assert!(limiter.acquire(b"k").await.is_none());
    }

    #[tokio::test]
    async fn checks_for_a_key_run_limit_at_a_time_so_a_window_admits_at_most_twice_the_limit_less_one() {
        let limiter = Arc::new(Limiter::new(3, Duration::from_secs(60)).unwrap());
        // three guesses hold the three slots: none has failed yet
        let mut held = Vec::new();
        for _ in 0..3 {
            held.push(limiter.acquire(b"k").await.unwrap());
        }
        // a fourth waits for a slot
        let waiting = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(b"k").await.map(|slot| slot.release(true)).is_some() }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiting.is_finished(), "it waits while three checks run");
        // two of the three fail: the waiter gets a slot and may still run (two failures so far)
        held.pop().unwrap().release(true);
        held.pop().unwrap().release(true);
        assert!(waiting.await.unwrap(), "the fourth guess ran");
        // now three failures: the one still running is the fifth and last guess of the window (2 × 3 − 1)
        assert!(limiter.acquire(b"k").await.is_none());
        held.pop().unwrap().release(true);
        assert!(limiter.acquire(b"k").await.is_none());
    }

    #[tokio::test]
    async fn a_waiter_is_refused_when_the_window_fills_while_it_waits() {
        let limiter = Arc::new(Limiter::new(1, Duration::from_secs(60)).unwrap());
        let running = limiter.acquire(b"k").await.unwrap();
        let waiting = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(b"k").await.is_some() }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        running.release(true);
        assert!(!waiting.await.unwrap());
    }

    #[tokio::test]
    async fn a_cancelled_waiter_leaves_nothing_behind() {
        let limiter = Arc::new(Limiter::new(1, WINDOW).unwrap());
        let running = limiter.acquire(b"k").await.unwrap();
        let waiting = tokio::spawn({
            let limiter = limiter.clone();
            async move { limiter.acquire(b"k").await.is_some() }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        waiting.abort();
        let _ = waiting.await;
        running.release(false);
        // idle and past its window, the key is swept at the next attempt for any key
        tokio::time::sleep(WINDOW + Duration::from_millis(30)).await;
        limiter.acquire(b"other").await.unwrap().release(false);
        assert_eq!(limiter.keys(), 1, "only the key just used is kept");
    }

    #[tokio::test]
    async fn long_keys_cost_no_more_memory_than_short_ones() {
        let limiter = Limiter::new(5, Duration::from_secs(60)).unwrap();
        let long = vec![b'x'; 1 << 20];
        limiter.acquire(&long).await.unwrap().release(true);
        assert_eq!(limiter.keys(), 1);
        assert_eq!(std::mem::size_of::<u64>(), 8, "a key is kept as its 8-byte hash");
    }
}
