//! JSON as Go's `encoding/json` writes it, for the answers that must be Navidrome's byte for byte: strings with Go's
//! escaping (HTML escaping on, as `json.Marshal` has it), numbers as Go formats them, and fields in the order the
//! caller writes them (Go: the struct's order). `omitempty` is the caller's choice of method: the `_ne` ("not empty")
//! ones leave a zero value out, as Go does for a field tagged `omitempty`.

/// Writes one JSON document. Commas are kept track of; everything else is the caller's.
pub struct Json {
    out: String,
    /// Per open object or array: whether a member was written, so the next one starts with a comma.
    written: Vec<bool>,
}

impl Default for Json {
    fn default() -> Self {
        Json::new()
    }
}

impl Json {
    pub fn new() -> Json {
        Json { out: String::with_capacity(4096), written: vec![false] }
    }

    pub fn finish(self) -> String {
        self.out
    }

    fn comma(&mut self) {
        if let Some(written) = self.written.last_mut() {
            if *written {
                self.out.push(',');
            }
            *written = true;
        }
    }

    /// The next member's name, in an object.
    pub fn key(&mut self, name: &str) -> &mut Self {
        self.comma();
        self.out.push('"');
        self.out.push_str(name); // names are ours: plain ASCII
        self.out.push_str("\":");
        // the value that follows is this member's, not a new one
        if let Some(written) = self.written.last_mut() {
            *written = false;
        }
        self
    }

    fn value_done(&mut self) {
        if let Some(written) = self.written.last_mut() {
            *written = true;
        }
    }

    pub fn begin_object(&mut self) {
        self.comma();
        self.out.push('{');
        self.written.push(false);
    }

    pub fn end_object(&mut self) {
        self.written.pop();
        self.out.push('}');
        self.value_done();
    }

    pub fn begin_array(&mut self) {
        self.comma();
        self.out.push('[');
        self.written.push(false);
    }

    pub fn end_array(&mut self) {
        self.written.pop();
        self.out.push(']');
        self.value_done();
    }

    pub fn object(&mut self, name: &str, members: impl FnOnce(&mut Json)) {
        self.key(name);
        self.begin_object();
        members(self);
        self.end_object();
    }

    /// An array member: every item writes itself as one value.
    pub fn array<T>(&mut self, name: &str, items: impl IntoIterator<Item = T>, mut item: impl FnMut(&mut Json, T)) {
        self.key(name);
        self.begin_array();
        for each in items {
            item(self, each);
        }
        self.end_array();
    }

    /// As `array`, left out when there is nothing in it (`omitempty` on a slice).
    pub fn array_ne<T>(&mut self, name: &str, items: &[T], item: impl FnMut(&mut Json, &T)) {
        if !items.is_empty() {
            self.array(name, items, item);
        }
    }

    pub fn string_value(&mut self, text: &str) {
        self.comma();
        string(&mut self.out, text);
    }

    pub fn string(&mut self, name: &str, text: &str) {
        self.key(name);
        string(&mut self.out, text);
        self.value_done();
    }

    pub fn string_ne(&mut self, name: &str, text: &str) {
        if !text.is_empty() {
            self.string(name, text);
        }
    }

    pub fn int(&mut self, name: &str, value: i64) {
        self.key(name);
        self.out.push_str(&value.to_string());
        self.value_done();
    }

    pub fn int_ne(&mut self, name: &str, value: i64) {
        if value != 0 {
            self.int(name, value);
        }
    }

    pub fn boolean(&mut self, name: &str, value: bool) {
        self.key(name);
        self.out.push_str(if value { "true" } else { "false" });
        self.value_done();
    }

    pub fn boolean_ne(&mut self, name: &str, value: bool) {
        if value {
            self.boolean(name, value);
        }
    }

    pub fn float(&mut self, name: &str, value: f64) {
        self.key(name);
        self.out.push_str(&float(value));
        self.value_done();
    }

    pub fn float_ne(&mut self, name: &str, value: f64) {
        if value != 0.0 {
            self.float(name, value);
        }
    }

    /// A float behind a pointer with `omitempty`: left out when there is none, written when it is zero.
    pub fn float_some(&mut self, name: &str, value: Option<f64>) {
        if let Some(value) = value {
            self.float(name, value);
        }
    }

    /// A time behind a pointer with `omitempty`, already as Go marshals it (`gotime`): left out when there is none.
    pub fn time_some(&mut self, name: &str, time: Option<&str>) {
        if let Some(time) = time {
            self.string(name, time);
        }
    }

    /// A `time.Time` field: always written, the zero time when there is none.
    pub fn time(&mut self, name: &str, time: Option<&str>) {
        self.string(name, time.unwrap_or(ZERO_TIME));
    }
}

/// Go's zero `time.Time` in JSON.
pub const ZERO_TIME: &str = "0001-01-01T00:00:00Z";

/// A string as Go's `encoding/json` writes it, with its HTML escaping: `<`, `>`, `&` and the two line separators as
/// `\uXXXX`.
pub fn string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A float64 as Go's `encoding/json` writes it: the shortest digits that read back the same, in plain notation,
/// except below 1e-6 and from 1e21 on, where it is `d.ddde±x` with at least one exponent digit. Go refuses NaN and
/// the infinities (the answer fails); SQLite stores neither, and they are written as 0 here.
pub fn float(value: f64) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    let abs = value.abs();
    if abs != 0.0 && !(1e-6..1e21).contains(&abs) {
        // Rust: 1e-7, 1.5e21; Go: 1e-07 cleaned to 1e-7, 1.5e+21
        let written = format!("{value:e}");
        return match written.split_once('e') {
            Some((digits, exponent)) if !exponent.starts_with('-') => format!("{digits}e+{exponent}"),
            _ => written,
        };
    }
    // Rust's Display is the shortest round-trip digits without an exponent: Go's 'f' with precision -1
    format!("{value}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_as_go_writes_them() {
        // strconv.AppendFloat(f, 'f', -1, 64), and 'e' outside [1e-6, 1e21), as encoding/json's floatEncoder
        for (value, expected) in [
            (0.0, "0"),
            (5.0, "5"),
            (-7.2, "-7.2"),
            (0.977, "0.977"),
            (4.5, "4.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (100.0, "100"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1.25e-9, "1.25e-9"),
            (-1e-10, "-1e-10"),
            (123456789.125, "123456789.125"),
            (3.3333333333333335, "3.3333333333333335"),
            (1e-320, "1e-320"),
        ] {
            assert_eq!(float(value), expected, "{value:e}");
        }
        assert_eq!(float(-0.0), "-0", "Go writes the sign of a negative zero");
        assert_eq!(float(f64::NAN), "0");
    }

    #[test]
    fn strings_as_go_writes_them() {
        let mut out = String::new();
        string(&mut out, "a<b>&\"c'\\\n\r\t\u{8}\u{c}\u{1}\u{7f}林é\u{2028}\u{2029}😀");
        let u = "\\u";
        assert_eq!(out, format!("\"a{u}003cb{u}003e{u}0026\\\"c'\\\\\\n\\r\\t\\b\\f{u}0001\u{7f}林é{u}2028{u}2029😀\""));
    }

    #[test]
    fn objects_arrays_and_omitted_fields() {
        let mut j = Json::new();
        j.begin_object();
        j.string("id", "a");
        j.string_ne("parent", "");
        j.boolean("isDir", false);
        j.boolean_ne("isVideo", false);
        j.int("songCount", 0);
        j.int_ne("year", 0);
        j.int_ne("track", 3);
        j.float_ne("averageRating", 0.0);
        j.float_ne("rating", 4.5);
        j.float_some("gain", Some(0.0));
        j.float_some("peak", None);
        j.time("created", None);
        j.time_some("starred", None);
        j.time_some("played", Some("2026-01-04T22:15:00+01:00"));
        j.array("genres", ["Rock", "Pop"], |j, name| {
            j.begin_object();
            j.string("name", name);
            j.end_object();
        });
        j.array("moods", Vec::<&str>::new(), |j, mood| j.string_value(mood));
        j.array_ne("song", &Vec::<i64>::new(), |_, _| {});
        j.array("isrc", ["A", "B"], |j, code| j.string_value(code));
        j.object("replayGain", |_| {});
        j.object("date", |j| j.int_ne("year", 2015));
        j.end_object();
        assert_eq!(
            j.finish(),
            r#"{"id":"a","isDir":false,"songCount":0,"track":3,"rating":4.5,"gain":0,"created":"0001-01-01T00:00:00Z","played":"2026-01-04T22:15:00+01:00","genres":[{"name":"Rock"},{"name":"Pop"}],"moods":[],"isrc":["A","B"],"replayGain":{},"date":{"year":2015}}"#
        );
    }
}
