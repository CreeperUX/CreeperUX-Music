//! A Subsonic request's parameters, read as Navidrome reads them (Go's `net/http` and `net/url`): from the query, and
//! for a form post (OpenSubsonic `formPost`) from the body too, the body's values first. A parameter's value is its
//! first one; an empty value counts as missing.
//!
//! Where Go would find the query or the form malformed, parsing fails here as well, and the gateway hands the request
//! to Navidrome as it came, to answer with its own error.

/// Navidrome reads at most this much of a form post (`postFormToQueryParams`: 10 MiB).
pub const MAX_FORM_BYTES: usize = 10 << 20;

/// Sent to sign a request: removed before an authenticated request goes on to Navidrome. (`jwt` never gets this
/// far: requests with one are Navidrome's to check.)
pub const CREDENTIALS: [&str; 4] = ["p", "t", "s", "apiKey"];

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Params {
    /// Decoded, in order: the form's, then the query's.
    pairs: Vec<(Vec<u8>, Vec<u8>)>,
}

impl Params {
    /// From the raw query and, for a form post, the raw body. None: Go's parser would refuse one of them.
    pub fn parse(query: &[u8], form: Option<&[u8]>) -> Option<Params> {
        let mut pairs = Vec::new();
        if let Some(form) = form {
            parse_into(form, &mut pairs)?;
        }
        parse_into(query, &mut pairs)?;
        Some(Params { pairs })
    }

    /// The parameter's first value, empty when there is none (Go: `r.URL.Query().Get(name)`).
    pub fn get(&self, name: &str) -> &[u8] {
        self.pairs.iter().find(|(key, _)| key == name.as_bytes()).map(|(_, value)| value.as_slice()).unwrap_or(b"")
    }

    /// Every value of the parameter, in order, empty ones too (Go: `r.URL.Query()[name]`).
    pub fn all(&self, name: &str) -> Vec<&[u8]> {
        self.pairs.iter().filter(|(key, _)| key == name.as_bytes()).map(|(_, value)| value.as_slice()).collect()
    }

    pub fn has(&self, name: &str) -> bool {
        !self.get(name).is_empty()
    }

    /// Whether the parameter is there at all, with a value or without (Go: `r.URL.Query()[name]`).
    pub fn names(&self, name: &str) -> bool {
        self.pairs.iter().any(|(key, _)| key == name.as_bytes())
    }
}

/// Go's `url.ParseQuery`: pairs separated by `&`, `+` a space, `%XX` a byte. A `;` in a pair or a bad escape is an
/// error there (the request then fails with it), so None here.
fn parse_into(raw: &[u8], pairs: &mut Vec<(Vec<u8>, Vec<u8>)>) -> Option<()> {
    for segment in raw.split(|b| *b == b'&') {
        if segment.contains(&b';') {
            return None;
        }
        if segment.is_empty() {
            continue;
        }
        let (key, value) = split_pair(segment);
        pairs.push((unescape(key)?, unescape(value)?));
    }
    Some(())
}

fn split_pair(segment: &[u8]) -> (&[u8], &[u8]) {
    match segment.iter().position(|b| *b == b'=') {
        Some(at) => (&segment[..at], &segment[at + 1..]),
        None => (segment, b""),
    }
}

/// Go's `url.QueryUnescape`.
fn unescape(text: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        match text[i] {
            b'%' => {
                let hex = text.get(i + 1..i + 3)?;
                out.push(crate::secrets::unhex(hex)?[0]);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    Some(out)
}

/// The raw query or form without the pairs named `names` (compared decoded: `%70=…` is `p`), the rest byte for byte.
/// For input `Params::parse` took.
pub fn without(raw: &[u8], names: &[&str]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut first = true;
    for segment in raw.split(|b| *b == b'&') {
        let key = unescape(split_pair(segment).0).unwrap_or_default();
        if !segment.is_empty() && names.iter().any(|name| name.as_bytes() == key) {
            continue;
        }
        if !first {
            out.push(b'&');
        }
        first = false;
        out.extend_from_slice(segment);
    }
    out
}

/// Whether Go's `Request.ParseForm` reads this request's body for parameters: a POST, PUT or PATCH whose
/// `Content-Type` is `application/x-www-form-urlencoded` (the type before the first `;`, in any case, as
/// `mime.ParseMediaType` gives it). Where Go would then refuse the type's parameters (`; charset` without a value),
/// the form is still read here: Navidrome answers the request with its error either way, signed in or not.
pub fn is_form(method: &hyper::Method, content_type: Option<&[u8]>) -> bool {
    if !matches!(*method, hyper::Method::POST | hyper::Method::PUT | hyper::Method::PATCH) {
        return false;
    }
    let Some(value) = content_type.and_then(|v| std::str::from_utf8(v).ok()) else { return false };
    let media = value.split(';').next().unwrap_or("");
    media.trim().eq_ignore_ascii_case("application/x-www-form-urlencoded")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(raw: &str) -> Option<Params> {
        Params::parse(raw.as_bytes(), None)
    }

    #[test]
    fn values_are_decoded_as_go_decodes_them() {
        let p = query("u=alice&p=a+b%20c%26d&c=&f=json&x&name=%E6%9E%97").unwrap();
        assert_eq!(p.get("u"), b"alice");
        assert_eq!(p.get("p"), b"a b c&d");
        assert_eq!(p.get("c"), b"", "empty counts as missing");
        assert!(!p.has("c"));
        assert_eq!(p.get("x"), b"");
        assert_eq!(p.get("name"), "林".as_bytes());
        assert_eq!(p.get("missing"), b"");
        assert_eq!(query("").unwrap(), Params::default());
        assert_eq!(query("&&u=a&&").unwrap().get("u"), b"a");
        assert_eq!(query("%75=a").unwrap().get("u"), b"a", "names are decoded too");
        assert_eq!(query("a=b=c").unwrap().get("a"), b"b=c");
        assert_eq!(query("p=%ff%00").unwrap().get("p"), &[0xff, 0][..], "bytes, not text");
    }

    #[test]
    fn the_first_value_counts_and_the_forms_come_first() {
        assert_eq!(query("u=first&u=second").unwrap().get("u"), b"first");
        let p = Params::parse(b"u=query&v=1", Some(b"u=form&c=app")).unwrap();
        assert_eq!(p.get("u"), b"form");
        assert_eq!(p.get("v"), b"1");
        assert_eq!(p.get("c"), b"app");
        // an empty first value is what Go's Get returns, even when a later one is not
        assert_eq!(Params::parse(b"u=query", Some(b"u=")).unwrap().get("u"), b"");
    }

    #[test]
    fn what_go_refuses_is_refused() {
        assert_eq!(query("u=a;p=b"), None, "a semicolon");
        assert_eq!(query("p=%zz"), None);
        assert_eq!(query("p=%4"), None);
        assert_eq!(query("p=%"), None);
        assert_eq!(query("%zz=1"), None);
        assert_eq!(Params::parse(b"u=a", Some(b"p=%zz")), None);
    }

    #[test]
    fn credentials_are_removed_and_the_rest_left_as_it_came() {
        let strip = |raw: &str| String::from_utf8(without(raw.as_bytes(), &CREDENTIALS)).unwrap();
        assert_eq!(strip("u=alice&p=secret&v=1.16.1&c=app&f=json"), "u=alice&v=1.16.1&c=app&f=json");
        assert_eq!(strip("t=abc&s=def&u=alice&id=1&id=2"), "u=alice&id=1&id=2");
        assert_eq!(strip("apiKey=k&c=app"), "c=app");
        assert_eq!(strip("%70=secret&u=a%20b&q=x+y"), "u=a%20b&q=x+y", "an escaped name is still the name; other escapes stay");
        assert_eq!(strip("p=1&p=2&P=3"), "P=3", "every value; names are case-sensitive");
        assert_eq!(strip("p&t=&s"), "");
        assert_eq!(strip("&&u=a&&"), "&&u=a&&");
        assert_eq!(strip(""), "");
        assert_eq!(strip("jwt=x&u=a"), "jwt=x&u=a");
    }

    #[test]
    fn only_urlencoded_bodies_of_post_put_and_patch_carry_parameters() {
        use hyper::Method;
        let post = |v: &str| is_form(&Method::POST, Some(v.as_bytes()));
        assert!(post("application/x-www-form-urlencoded"));
        assert!(post("Application/X-WWW-Form-Urlencoded; charset=UTF-8"));
        assert!(post(" application/x-www-form-urlencoded ;charset=\"utf-8\""));
        assert!(post("application/x-www-form-urlencoded; charset"), "Go refuses the parameter, after reading the form");
        assert!(!post("application/json"));
        assert!(!post("multipart/form-data; boundary=x"));
        assert!(!post("application/x-www-form-urlencoded2"));
        assert!(!post(""));
        assert!(!is_form(&Method::POST, None));
        let form = Some(&b"application/x-www-form-urlencoded"[..]);
        assert!(is_form(&Method::PUT, form) && is_form(&Method::PATCH, form));
        assert!(!is_form(&Method::GET, form) && !is_form(&Method::DELETE, form) && !is_form(&Method::HEAD, form));
    }
}
