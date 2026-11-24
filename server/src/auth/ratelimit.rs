//! The per-address rate limit of the sign-in routes: go-chi/httprate's sliding-window counter, as Navidrome uses it
//! (`ClientIPRateLimiter`: `AuthRequestLimit` requests per `AuthWindowLength`, one count shared by every limited route
//! under `/auth`). Unlike the Subsonic limiter it counts every request, not only failures.
//!
//! Time is cut into windows of the limit's length, starting when the limiter was made. A request's rate is the count
//! in the current window plus the previous window's count, weighted by how much of that window still lies within one
//! window's length from now. At the limit, a request is refused with 429 and is not counted.
//!
//! Ported from go-chi/httprate (MIT), © the go-chi authors.

use std::collections::HashMap;
use std::hash::{BuildHasher, RandomState};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct RateLimiter {
    limit: i64,
    window: Duration,
    start: Instant,
    start_unix: u64,
    hasher: RandomState,
    counts: Mutex<Counts>,
}

#[derive(Default)]
struct Counts {
    /// The window the counts are for.
    window: u64,
    current: HashMap<u64, i64>,
    previous: HashMap<u64, i64>,
}

/// What a request is told: the `X-RateLimit-*` headers of every answer, and `Retry-After` when refused.
#[derive(Debug, PartialEq)]
pub struct Verdict {
    pub limited: bool,
    pub limit: i64,
    pub remaining: i64,
    /// When the current window ends, seconds since 1970.
    pub reset: u64,
    /// Seconds to wait, when refused.
    pub retry_after: u64,
}

impl RateLimiter {
    /// None when `limit` is not positive: no limit, as in Navidrome.
    pub fn new(limit: i64, window: Duration) -> Option<RateLimiter> {
        if limit <= 0 || window.is_zero() {
            return None;
        }
        let start_unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        Some(RateLimiter { limit, window, start: Instant::now(), start_unix, hasher: RandomState::new(), counts: Mutex::new(Counts::default()) })
    }

    /// Counts a request for `key` (the client's address) unless it is over the limit.
    pub fn hit(&self, key: &str) -> Verdict {
        self.hit_at(key, self.start.elapsed())
    }

    fn hit_at(&self, key: &str, since_start: Duration) -> Verdict {
        let window = (since_start.as_nanos() / self.window.as_nanos()) as u64;
        let into = since_start.as_nanos() % self.window.as_nanos();
        let key = self.hasher.hash_one(key);
        let reset = self.start_unix + ((window + 1) as u128 * self.window.as_nanos() / 1_000_000_000) as u64;

        let mut counts = self.counts.lock().expect("the rate limiter's lock");
        // a new window: what was current is the previous one, or long gone
        if counts.window != window {
            counts.previous = if counts.window + 1 == window { std::mem::take(&mut counts.current) } else { HashMap::new() };
            counts.current.clear();
            counts.window = window;
        }
        let current = counts.current.get(&key).copied().unwrap_or(0);
        let previous = counts.previous.get(&key).copied().unwrap_or(0);
        let weight = (self.window.as_nanos() - into) as f64 / self.window.as_nanos() as f64;
        let rate = (previous as f64 * weight + current as f64).round() as i64;
        if rate + 1 > self.limit {
            return Verdict { limited: true, limit: self.limit, remaining: self.limit - rate, reset, retry_after: self.window.as_secs() };
        }
        *counts.current.entry(key).or_insert(0) += 1;
        Verdict { limited: false, limit: self.limit, remaining: self.limit - rate - 1, reset, retry_after: 0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(20);

    fn at(seconds: f64) -> Duration {
        Duration::from_secs_f64(seconds)
    }

    #[test]
    fn no_limit_when_the_limit_is_not_positive() {
        assert!(RateLimiter::new(0, WINDOW).is_none());
        assert!(RateLimiter::new(-5, WINDOW).is_none());
        assert!(RateLimiter::new(5, WINDOW).is_some());
    }

    #[test]
    fn requests_over_the_limit_in_a_window_are_refused_and_not_counted() {
        let limiter = RateLimiter::new(3, WINDOW).unwrap();
        for (n, remaining) in [(1, 2), (2, 1), (3, 0)] {
            let v = limiter.hit_at("ip", at(n as f64));
            assert_eq!((v.limited, v.limit, v.remaining), (false, 3, remaining), "request {n}");
        }
        let refused = limiter.hit_at("ip", at(4.0));
        assert_eq!((refused.limited, refused.remaining, refused.retry_after), (true, 0, 20));
        assert!(limiter.hit_at("ip", at(5.0)).limited);
        assert!(!limiter.hit_at("other", at(5.0)).limited, "another address has its own count");
        assert_eq!(refused.reset, limiter.start_unix + 20, "the window's end");
    }

    #[test]
    fn the_previous_window_counts_by_the_part_of_it_still_in_reach() {
        let limiter = RateLimiter::new(4, WINDOW).unwrap();
        for _ in 0..4 {
            assert!(!limiter.hit_at("ip", at(19.0)).limited);
        }
        // just into the next window, nearly all of the previous one still counts: 4 × 0.95 = 3.8 → 4
        assert!(limiter.hit_at("ip", at(21.0)).limited);
        // halfway through, half of it: 2, so two more fit
        assert!(!limiter.hit_at("ip", at(30.0)).limited);
        assert!(!limiter.hit_at("ip", at(30.0)).limited);
        assert!(limiter.hit_at("ip", at(30.0)).limited);
        // two windows later nothing of it is left
        let fresh = limiter.hit_at("ip", at(65.0));
        assert_eq!((fresh.limited, fresh.remaining), (false, 3));
    }

    #[test]
    fn idle_addresses_are_forgotten() {
        let limiter = RateLimiter::new(4, WINDOW).unwrap();
        for i in 0..100 {
            limiter.hit_at(&format!("ip-{i}"), at(1.0));
        }
        limiter.hit_at("ip", at(50.0));
        let counts = limiter.counts.lock().unwrap();
        assert_eq!((counts.current.len(), counts.previous.len()), (1, 0));
    }
}
