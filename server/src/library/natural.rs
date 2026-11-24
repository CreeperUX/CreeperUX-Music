//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! Navidrome's `NATSORT` collation (`utils/natural`, `CompareFold`), which its sort orders name when
//! `EnableNaturalSorting` is on: runs of digits compare by their value ("file2" before "file10"), everything else
//! byte by byte with ASCII letters folded, as SQLite's NOCASE folds them.

use std::cmp::Ordering;

/// `natural.CompareFold`.
pub fn compare_fold(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut ia, mut ib) = (0, 0);
    // two runs with the same value but other padding ("01", "1") decide only strings that are otherwise equal
    let mut pad_tie = Ordering::Equal;
    while ia < a.len() && ib < b.len() {
        let (ca, cb) = (a[ia], b[ib]);
        let (da, db) = (ca.is_ascii_digit(), cb.is_ascii_digit());
        let (ca, cb) = (ca.to_ascii_lowercase(), cb.to_ascii_lowercase());
        if da && db {
            let end_a = ia + a[ia..].iter().take_while(|c| c.is_ascii_digit()).count();
            let end_b = ib + b[ib..].iter().take_while(|c| c.is_ascii_digit()).count();
            let (run_a, run_b) = (&a[ia..end_a], &b[ib..end_b]);
            let by_value = compare_numbers(run_a, run_b);
            if by_value != Ordering::Equal {
                return by_value;
            }
            if run_a != run_b {
                pad_tie = run_a.cmp(run_b);
            }
            (ia, ib) = (end_a, end_b);
        } else if da != db || ca != cb {
            return ca.cmp(&cb);
        } else {
            ia += 1;
            ib += 1;
        }
    }
    (a.len() - ia).cmp(&(b.len() - ib)).then(pad_tie)
}

/// Two runs of digits by their value: without their leading zeros, the longer is the larger.
fn compare_numbers(a: &[u8], b: &[u8]) -> Ordering {
    let (a, b) = (strip_zeros(a), strip_zeros(b));
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn strip_zeros(digits: &[u8]) -> &[u8] {
    let zeros = digits.iter().take_while(|c| **c == b'0').count();
    if zeros == digits.len() && !digits.is_empty() { &digits[digits.len() - 1..] } else { &digits[zeros..] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::{Equal, Greater, Less};

    #[test]
    fn numbers_compare_by_value_and_letters_fold() {
        // the cases of Navidrome's utils/natural/natural_test.go
        for (a, b, expected) in [
            ("file2", "file10", Less),
            ("file10", "file2", Greater),
            ("abc", "abc", Equal),
            ("", "", Equal),
            ("", "a", Less),
            ("a", "", Greater),
            ("a1", "a01", Greater),
            ("a01", "a1", Less),
            ("a0", "a00", Less),
            ("Album 2", "album 10", Less),
            ("ALBUM", "album", Equal),
            ("track 9", "track 10", Less),
            ("1", "a", Less),
            ("a", "1", Greater),
            ("a2b", "a10a", Less),
            ("x01y1", "x1y01", Greater),
            ("x01y2", "x1y1", Greater),
            ("100", "99", Greater),
            ("000", "0", Greater),
            ("é", "É", Greater),
        ] {
            assert_eq!(compare_fold(a, b), expected, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn the_order_is_transitive() {
        // what SQLite needs of a collation: sorting three ways round gives one order
        let mut names = vec!["a1", "a01", "a001", "a1b", "a01a", "a2", "A10", "a", "B", "b2", "b02"];
        names.sort_by(|a, b| compare_fold(a, b));
        for window in names.windows(2) {
            assert_ne!(compare_fold(window[0], window[1]), Greater);
        }
        for a in &names {
            for b in &names {
                assert_eq!(compare_fold(a, b), compare_fold(b, a).reverse(), "{a} {b}");
            }
        }
    }
}
