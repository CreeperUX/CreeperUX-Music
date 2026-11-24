//! Timestamps as Navidrome's database has them. Its SQLite driver (go-sqlite3) writes a Go `time.Time` as
//! `2006-01-02 15:04:05.999999999-07:00`: the time's own offset (Navidrome writes most in local time, some in UTC),
//! and as many fractional digits as it has, none (and no dot) when it has none. Columns are compared as text, so
//! what is written here has the very same shape.

use chrono::{DateTime, FixedOffset, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc};

/// As go-sqlite3 writes it.
pub fn format<Tz: TimeZone>(time: &DateTime<Tz>) -> String {
    let local = time.naive_local();
    let mut out = local.format("%Y-%m-%d %H:%M:%S").to_string();
    let nanos = local.nanosecond() % 1_000_000_000;
    if nanos != 0 {
        let digits = format!("{nanos:09}");
        out.push('.');
        out.push_str(digits.trim_end_matches('0'));
    }
    let offset = time.offset().fix().local_minus_utc();
    let (sign, offset) = if offset < 0 { ('-', -offset) } else { ('+', offset) };
    out.push_str(&format!("{sign}{:02}:{:02}", offset / 3600, offset % 3600 / 60));
    out
}

use chrono::Offset;

/// Now, in UTC: what Navidrome's two-step verification store writes (`s.now().UTC()`).
pub fn now_utc() -> String {
    format(&Utc::now())
}

/// Now, in the server's local time: what Navidrome writes for `time.Now()` (a user's `last_access_at`).
pub fn now_local() -> String {
    format(&Local::now())
}

/// Reads what go-sqlite3 reads back as a time (its `SQLiteTimestampFormats`): a date, then optionally a time after a
/// space or `T`, fractional seconds, and an offset or `Z`. Without an offset it is UTC.
pub fn parse(text: &str) -> Option<DateTime<Utc>> {
    let text = text.trim_end_matches('Z');
    let (date, rest) = match text.find([' ', 'T']) {
        Some(at) => (&text[..at], &text[at + 1..]),
        None => (text, ""),
    };
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    if rest.is_empty() {
        return Some(Utc.from_utc_datetime(&date.and_time(NaiveTime::MIN)));
    }
    // the offset starts at the last + or - (a time has none of its own)
    let (clock, offset) = match rest.rfind(['+', '-']) {
        Some(at) => (&rest[..at], Some(&rest[at..])),
        None => (rest, None),
    };
    let time = ["%H:%M:%S%.f", "%H:%M"].iter().find_map(|f| NaiveTime::parse_from_str(clock, f).ok())?;
    let naive = NaiveDateTime::new(date, time);
    match offset {
        None => Some(Utc.from_utc_datetime(&naive)),
        Some(offset) => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let (hours, minutes) = offset[1..].split_once(':')?;
            let seconds = sign * (hours.parse::<i32>().ok()? * 3600 + minutes.parse::<i32>().ok()? * 60);
            let zone = FixedOffset::east_opt(seconds)?;
            zone.from_local_datetime(&naive).single().map(|t| t.with_timezone(&Utc))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(offset_hours: i32, nanos: u32) -> DateTime<FixedOffset> {
        let zone = FixedOffset::east_opt(offset_hours * 3600).unwrap();
        zone.with_ymd_and_hms(2026, 11, 24, 21, 1, 53).unwrap().with_nanosecond(nanos).unwrap()
    }

    #[test]
    fn written_as_go_writes_them() {
        // values from a database Navidrome wrote (tools/fixtures)
        assert_eq!(format(&at(1, 596_376_800)), "2026-11-24 21:01:53.5963768+01:00");
        assert_eq!(format(&at(0, 34_582_900)), "2026-11-24 21:01:53.0345829+00:00");
        assert_eq!(format(&at(0, 0)), "2026-11-24 21:01:53+00:00", "no fraction, no dot");
        assert_eq!(format(&at(-7, 500_000_000)), "2026-11-24 21:01:53.5-07:00");
        assert_eq!(format(&at(0, 1)), "2026-11-24 21:01:53.000000001+00:00");
        let half = FixedOffset::east_opt(5 * 3600 + 1800).unwrap().with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        assert_eq!(format(&half), "2026-01-02 03:04:05+05:30");
    }

    #[test]
    fn read_as_go_reads_them() {
        let utc = |h, mi, s, n| Utc.with_ymd_and_hms(2026, 11, 24, h, mi, s).unwrap().with_nanosecond(n).unwrap();
        assert_eq!(parse("2026-11-24 21:01:53.5963768+01:00"), Some(utc(20, 1, 53, 596_376_800)));
        assert_eq!(parse("2026-11-24 20:01:52.0405568+00:00"), Some(utc(20, 1, 52, 40_556_800)));
        assert_eq!(parse("2026-11-24T20:01:52Z"), Some(utc(20, 1, 52, 0)));
        assert_eq!(parse("2026-11-24 20:01:52"), Some(utc(20, 1, 52, 0)));
        assert_eq!(parse("2026-11-24 13:01:52-07:00"), Some(utc(20, 1, 52, 0)));
        assert_eq!(parse("2026-11-24 20:01"), Some(utc(20, 1, 0, 0)));
        assert_eq!(parse("2026-11-24"), Some(utc(0, 0, 0, 0)));
        assert_eq!(parse(""), None);
        assert_eq!(parse("yesterday"), None);
    }

    #[test]
    fn what_is_written_reads_back() {
        let time = at(1, 123_456_789);
        assert_eq!(parse(&format(&time)), Some(time.with_timezone(&Utc)));
        assert!(parse(&now_utc()).is_some());
        assert!(parse(&now_local()).is_some());
        assert!(now_utc().ends_with("+00:00"));
    }
}
