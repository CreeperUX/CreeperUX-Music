//! Ported from mileusna/useragent v1.3.5 (MIT, © Miloš Mileusnić), as Navidrome uses it (`canonicalUserAgent`):
//! the browser's name and the operating system of a `User-Agent`, which Navidrome stores as a player's `user_agent`
//! (`<name>/<os>`) and matches players by. Only what decides those two is ported, including the token changes the
//! device lookup makes on the way.

/// One token: a product and its version, or a comment.
#[derive(Debug, Clone)]
struct Property {
    key: String,
    value: String,
}

#[derive(Debug, Default)]
struct Properties {
    list: Vec<Property>,
    url: String,
}

/// Go's `bytes.TrimSpace` / `strings.TrimSpace`.
fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace())
}

/// `ignore`.
fn ignore(token: &str) -> bool {
    matches!(token, "KHTML, like Gecko" | "U" | "compatible" | "Mozilla" | "WOW64" | "en" | "en-us" | "en-gb" | "ru-ru" | "Browser")
}

/// `checkVer`: a version at the end of a known token.
fn check_ver(s: &str) -> Property {
    let Some(i) = s.rfind(' ') else { return Property { key: s.into(), value: String::new() } };
    match &s[..i] {
        "Linux" | "Windows NT" | "Windows Phone OS" | "MSIE" | "Android" | "OpenHarmony" => Property { key: s[..i].into(), value: s[i + 1..].into() },
        "CrOS x86_64" | "CrOS aarch64" | "CrOS armv7l" => {
            let j = s[..i].rfind(' ').expect("a space");
            Property { key: s[..j].into(), value: s[j + 1..i].into() }
        }
        _ => Property { key: s.into(), value: String::new() },
    }
}

/// `parse`: the tokens of a user agent, byte by byte as Go walks it.
fn parse(ua: &[u8]) -> Properties {
    let mut clients = Properties::default();
    let mut buff: Vec<u8> = Vec::new();
    let mut val: Vec<u8> = Vec::new();
    let (mut slash, mut is_url, mut par_open, mut bra_open) = (false, false, false, false);
    let add_token = |clients: &mut Properties, buff: &mut Vec<u8>, val: &mut Vec<u8>, slash: &mut bool, is_url: &mut bool| {
        if !buff.is_empty() {
            let text = String::from_utf8_lossy(buff);
            let s = trim(&text);
            if !ignore(s) {
                if *is_url {
                    clients.url = s.trim_start_matches('+').to_string();
                    // Go returns before resetting
                    return;
                }
                if val.is_empty() {
                    clients.list.push(check_ver(s));
                } else {
                    clients.list.push(Property { key: s.into(), value: trim(&String::from_utf8_lossy(val)).into() });
                }
            }
        }
        buff.clear();
        val.clear();
        *slash = false;
        *is_url = false;
    };
    for (i, &c) in ua.iter().enumerate() {
        let next = ua.get(i + 1).copied();
        match c {
            b')' => {
                add_token(&mut clients, &mut buff, &mut val, &mut slash, &mut is_url);
                par_open = false;
            }
            b';' => add_token(&mut clients, &mut buff, &mut val, &mut slash, &mut is_url),
            b'(' => {
                add_token(&mut clients, &mut buff, &mut val, &mut slash, &mut is_url);
                par_open = true;
            }
            b'[' => {
                add_token(&mut clients, &mut buff, &mut val, &mut slash, &mut is_url);
                bra_open = true;
            }
            b']' => {
                add_token(&mut clients, &mut buff, &mut val, &mut slash, &mut is_url);
                bra_open = false;
            }
            b':' => {
                if buff.ends_with(b"http") || buff.ends_with(b"https") {
                    buff.push(c);
                } else if i != ua.len() - 1 && next != Some(b' ') {
                    buff.push(b' ');
                }
            }
            b' ' if slash => add_token(&mut clients, &mut buff, &mut val, &mut slash, &mut is_url),
            _ if slash => val.push(c),
            b'/' if !is_url => {
                if i != ua.len() - 1 && next == Some(b'/') && (buff.ends_with(b"http:") || buff.ends_with(b"https:")) {
                    buff.push(c);
                    is_url = true;
                } else if ignore(&String::from_utf8_lossy(&buff)) {
                    buff.clear();
                } else {
                    slash = true;
                }
            }
            _ => buff.push(c),
        }
    }
    let _ = (par_open, bra_open);
    add_token(&mut clients, &mut buff, &mut val, &mut slash, &mut is_url);
    clients
}

impl Properties {
    fn get(&self, key: &str) -> &str {
        self.list.iter().find(|p| p.key == key).map(|p| p.value.as_str()).unwrap_or("")
    }

    fn exists(&self, key: &str) -> bool {
        self.list.iter().any(|p| p.key == key)
    }

    fn exists_any(&self, keys: &[&str]) -> bool {
        keys.iter().any(|k| self.exists(k))
    }

    fn starts_with(&self, prefix: &str) -> bool {
        self.list.iter().any(|p| p.key.starts_with(prefix))
    }

    fn index_of(&self, key: &str) -> Option<usize> {
        self.list.iter().position(|p| p.key == key)
    }

    /// `findBestMatch`.
    fn best_match(&self, with_version_only: bool) -> Option<String> {
        let rounds = if with_version_only { 1 } else { 2 };
        for round in 0..rounds {
            for p in &self.list {
                match p.key.as_str() {
                    "Chrome" | "Firefox" | "Safari" | "Version" | "Mobile" | "Mobile Safari" | "Mozilla" | "AppleWebKit" | "Windows NT"
                    | "Windows Phone OS" | "Android" | "Macintosh" | "Linux" | "GSA" | "CrOS" | "Tablet" | "OpenHarmony" => {}
                    key => {
                        if key.as_bytes().first().is_some_and(u8::is_ascii_digit) {
                            continue;
                        }
                        if round == 1 || !p.value.is_empty() {
                            return Some(key.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    /// `findAndroidDevice`: drops the device's token (or renames a tablet's), which later lookups then do not see.
    fn android_device(&mut self, start: Option<usize>) {
        // Go starts at -1 when Android has no token of its own: the token after it is then the first one
        let start = start.map(|i| i as isize).unwrap_or(-1);
        let next = (start + 1) as usize;
        if self.list.len() as isize <= start + 1 {
            return;
        }
        let dev = self.list[next].key.clone();
        if dev.len() == 2 || (dev.len() == 5 && dev.as_bytes()[2] == b'-') {
            return;
        }
        match dev.as_str() {
            "Chrome" | "Firefox" | "Safari" | "Opera Mini" | "Presto" | "Version" | "Mobile" | "Mobile Safari" | "Mozilla" | "AppleWebKit" | "Windows NT"
            | "Windows Phone OS" | "Android" | "Macintosh" | "Linux" | "CrOS" => {}
            _ => {
                if dev.to_lowercase().contains("tablet") {
                    self.list[next].key = "Tablet".into();
                } else {
                    self.list.remove(next);
                }
            }
        }
    }

    fn instagram_version_exists(&self) -> bool {
        self.starts_with("Instagram")
    }
}

/// `Parse`, for the name and the OS.
pub fn name_and_os(user_agent: &str) -> (String, String) {
    let mut tokens = parse(user_agent.as_bytes());
    let mut os = "";
    if tokens.exists("Android") {
        os = "Android";
        let at = tokens.index_of("Android");
        tokens.android_device(at);
    } else if tokens.exists("iPhone") || tokens.exists("iPad") {
        os = "iOS";
    } else if tokens.exists("Windows NT") {
        os = "Windows";
    } else if tokens.exists("Windows Phone OS") {
        os = "Windows Phone";
    } else if tokens.exists("Macintosh") {
        os = "macOS";
    } else if tokens.exists("Linux") {
        os = "Linux";
    } else if tokens.exists("FreeBSD") {
        os = "FreeBSD";
    } else if tokens.exists("CrOS") {
        os = "ChromeOS";
    } else if tokens.exists("BlackBerry") {
        os = "BlackBerry";
    } else if tokens.exists("OpenHarmony") {
        os = "Harmony";
    }
    let named = |name: &str| name.to_string();
    let t = &tokens;
    let name: String = if t.exists("Googlebot") {
        named("Googlebot")
    } else if t.exists_any(&["GoogleProber", "GoogleProducer"]) {
        t.best_match(false).unwrap_or_default()
    } else if t.exists("Bytespider") {
        named("Bytespider")
    } else if t.exists("Applebot") {
        os = "";
        named("Applebot")
    } else if !t.get("Opera Mini").is_empty() {
        named("Opera Mini")
    } else if !t.get("OPR").is_empty() {
        named("Opera")
    } else if !t.get("OPT").is_empty() {
        named("Opera Touch")
    } else if !t.get("OPiOS").is_empty() {
        named("Opera")
    } else if !t.get("CriOS").is_empty() {
        named("Chrome")
    } else if !t.get("FxiOS").is_empty() || !t.get("Firefox").is_empty() {
        named("Firefox")
    } else if !t.get("Vivaldi").is_empty() {
        named("Vivaldi")
    } else if t.exists("MSIE") {
        named("Internet Explorer")
    } else if !t.get("EdgiOS").is_empty() || !t.get("Edge").is_empty() || !t.get("Edg").is_empty() || !t.get("EdgA").is_empty() {
        named("Edge")
    } else if !t.get("bingbot").is_empty() {
        named("Bingbot")
    } else if !t.get("YandexBot").is_empty() {
        named("YandexBot")
    } else if !t.get("YandexAdNet").is_empty() {
        named("YandexAdNet")
    } else if !t.get("SamsungBrowser").is_empty() {
        os = "Android";
        named("Samsung Browser")
    } else if !t.get("HeadlessChrome").is_empty() {
        named("Headless Chrome")
    } else if t.exists_any(&["AdsBot-Google-Mobile", "Mediapartners-Google", "AdsBot-Google"]) {
        named("Google Ads Bot")
    } else if t.exists("Yahoo Ad monitoring") {
        named("Yahoo Ad monitoring")
    } else if t.exists("XiaoMi") {
        if t.get("XiaoMi").starts_with("MiuiBrowser") { named("Miui Browser") } else { String::new() }
    } else if t.exists("FBAN") || t.exists("FB_IAB") {
        named("Facebook App")
    } else if t.instagram_version_exists() {
        named("Instagram App")
    } else if t.exists("BytedanceWebview") {
        named("TikTok App")
    } else if !t.get("HuaweiBrowser").is_empty() {
        named("Huawei Browser")
    } else if t.exists("BlackBerry") {
        named("BlackBerry")
    } else if t.exists("NetFront") {
        named("NetFront")
    } else if t.exists("Chrome") && t.exists("Safari") {
        // any other token with a version; else Chrome (Go's fallthrough)
        t.best_match(true).unwrap_or_else(|| named("Chrome"))
    } else if t.exists("Chrome") || t.exists("Brave Chrome") {
        named("Chrome")
    } else if t.exists("Safari") {
        named("Safari")
    } else if os == "Android" && !t.get("Version").is_empty() {
        named("Android browser")
    } else {
        t.best_match(false).unwrap_or_else(|| user_agent.to_string())
    };
    (name, os.to_string())
}

/// `canonicalUserAgent`: the name, and the OS after a slash when there is one.
pub fn canonical(user_agent: &str) -> String {
    let (name, os) = name_and_os(user_agent);
    if os.is_empty() { name } else { format!("{name}/{os}") }
}

#[cfg(test)]
#[path = "useragent_cases.rs"]
mod cases;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_librarys_own_cases() {
        let mut wrong = Vec::new();
        for (ua, name, os) in cases::CASES {
            let got = name_and_os(ua);
            if got.0 != *name || (*os != "?" && got.1 != *os) {
                wrong.push(format!("{ua}\n  want {name:?} {os:?}\n  got  {:?} {:?}", got.0, got.1));
            }
        }
        assert!(wrong.is_empty(), "{} of {} cases differ:\n{}", wrong.len(), cases::CASES.len(), wrong.join("\n"));
    }

    #[test]
    fn what_navidrome_stores() {
        assert_eq!(
            canonical("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
            "Chrome/Windows"
        );
        assert_eq!(canonical("okhttp/4.12.0"), "okhttp");
        assert_eq!(canonical(""), "");
        assert_eq!(canonical("Sonus/0.2.0 (Windows)"), "Sonus", "a bare Windows is no operating system token");
    }
}
