//! The mirror's brakes on the home connection: a byte rate for uploads, the hours they may start in, and (with the
//! ledger's day count) a cap on the bytes a day.

use std::sync::Mutex;
use std::time::Duration;

use chrono::NaiveTime;
use tokio::time::Instant;

/// Paces the bytes sent: each piece waits until the ones before it have had their share of time. `0` bytes a
/// second sends at the connection's own speed.
pub struct Rate {
    bytes_per_second: u64,
    next: Mutex<Option<Instant>>,
}

impl Rate {
    pub fn new(bytes_per_second: u64) -> Rate {
        Rate { bytes_per_second, next: Mutex::new(None) }
    }

    pub async fn take(&self, bytes: usize) {
        if self.bytes_per_second == 0 {
            return;
        }
        let start = {
            let mut next = self.next.lock().expect("the rate's lock");
            let now = Instant::now();
            // an idle stretch is not saved up for a burst later
            let start = next.filter(|n| *n > now).unwrap_or(now);
            *next = Some(start + Duration::from_secs_f64(bytes as f64 / self.bytes_per_second as f64));
            start
        };
        tokio::time::sleep_until(start).await;
    }
}

/// The hours of the day (the server's time zone) uploads may start in: `start` up to `end`, across midnight when
/// `end` comes first; none: any time. An upload under way when they end is finished.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hours {
    pub start: NaiveTime,
    pub end: NaiveTime,
}

impl Hours {
    /// `00:00-07:00`; `all` (or `always`): none.
    pub fn parse(text: &str) -> Result<Option<Hours>, String> {
        let text = text.trim();
        if text.eq_ignore_ascii_case("all") || text.eq_ignore_ascii_case("always") {
            return Ok(None);
        }
        let (start, end) = text.split_once('-').ok_or_else(|| format!("{text} is not hours like 00:00-07:00, or all"))?;
        let time = |t: &str| NaiveTime::parse_from_str(t.trim(), "%H:%M").map_err(|_| format!("{t} is not a time like 07:00"));
        let hours = Hours { start: time(start)?, end: time(end)? };
        if hours.start == hours.end {
            return Err(format!("{text}: the hours start where they end; write all for any time"));
        }
        Ok(Some(hours))
    }

    pub fn contains(&self, time: NaiveTime) -> bool {
        if self.start < self.end { self.start <= time && time < self.end } else { time >= self.start || time < self.end }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn hours() {
        let night = Hours::parse("00:00-07:00").unwrap().unwrap();
        assert!(night.contains(at(0, 0)) && night.contains(at(6, 59)) && !night.contains(at(7, 0)) && !night.contains(at(23, 0)));
        let late = Hours::parse(" 22:30 - 06:00 ").unwrap().unwrap();
        assert!(late.contains(at(23, 0)) && late.contains(at(5, 0)) && !late.contains(at(12, 0)) && !late.contains(at(22, 29)));
        assert_eq!(Hours::parse("all").unwrap(), None);
        assert!(Hours::parse("7-8").is_err() && Hours::parse("01:00-01:00").is_err() && Hours::parse("night").is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn rate() {
        let rate = Rate::new(1000);
        let started = Instant::now();
        for _ in 0..5 {
            rate.take(1000).await;
        }
        // the first piece goes at once; the fifth waits for the four before it
        assert_eq!(started.elapsed(), Duration::from_secs(4));
        let free = Rate::new(0);
        free.take(usize::MAX).await;
        assert_eq!(started.elapsed(), Duration::from_secs(4));
    }
}
