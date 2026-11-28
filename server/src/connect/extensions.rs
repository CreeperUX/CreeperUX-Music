//! `getOpenSubsonicExtensions`: Navidrome answers it, and the gateway adds what the Rust server speaks itself
//! (`docs/server-roadmap.md`, phase 1). Only the list changes: an extension both know gets the versions of both, one
//! only this server knows is added at the end. The rest of the answer stays as Navidrome wrote it, byte for byte, in
//! each of its three formats (JSON, JSONP, XML).

use serde_json::{Value, json};

/// What the Rust server answers itself: Sonus Connect version 2 (version 1 is still Navidrome's).
pub const OURS: &[(&str, &[u64])] = &[("sonusConnect", &[2])];
/// Advertised when the playback library (`SONUS_RENDITIONS_ENABLED`) is on.
pub const OURS_WITH_RENDITIONS: &[(&str, &[u64])] = &[("sonusConnect", &[2]), ("sonusRenditions", &[1])];

const JSON_LIST: &[u8] = b"\"openSubsonicExtensions\":[";

/// Navidrome's answer with `ours` merged in. None: not an answer with a list this knows (an error, another format):
/// it then goes out as it came.
pub fn merge(body: &[u8], ours: &[(&str, &[u64])]) -> Option<Vec<u8>> {
    match find(body, JSON_LIST) {
        Some(at) => merge_json(body, at + JSON_LIST.len() - 1, ours),
        None => merge_xml(body, ours),
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn union(versions: &mut Vec<u64>, more: &[u64]) {
    versions.extend_from_slice(more);
    versions.sort_unstable();
    versions.dedup();
}

/// `open` is where the list's `[` is.
fn merge_json(body: &[u8], open: usize, ours: &[(&str, &[u64])]) -> Option<Vec<u8>> {
    // the list's end: its closing bracket, outside any string
    let (mut depth, mut in_string, mut escaped, mut close) = (0usize, false, false, None);
    for (i, b) in body.iter().enumerate().skip(open) {
        if in_string {
            match b {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' | b'{' => depth += 1,
            b']' | b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    let mut list: Vec<Value> = serde_json::from_slice(&body[open..=close]).ok()?;
    for (name, versions) in ours {
        let known = list.iter_mut().find(|e| e.get("name").and_then(Value::as_str) == Some(name));
        match known {
            Some(extension) => {
                let mut all: Vec<u64> = extension.get("versions")?.as_array()?.iter().map(Value::as_u64).collect::<Option<_>>()?;
                union(&mut all, versions);
                extension.as_object_mut()?.insert("versions".into(), json!(all));
            }
            None => list.push(json!({ "name": name, "versions": versions })),
        }
    }
    // as Go writes it: compact, `name` before `versions`
    let merged = serde_json::to_vec(&list).ok()?;
    let mut out = Vec::with_capacity(body.len() + 64);
    out.extend_from_slice(&body[..open]);
    out.extend_from_slice(&merged);
    out.extend_from_slice(&body[close + 1..]);
    Some(out)
}

fn xml_element(name: &str, versions: &[u64]) -> String {
    let versions: String = versions.iter().map(|v| format!("<versions>{v}</versions>")).collect();
    format!("<openSubsonicExtensions name=\"{name}\">{versions}</openSubsonicExtensions>")
}

fn merge_xml(body: &[u8], ours: &[(&str, &[u64])]) -> Option<Vec<u8>> {
    const END: &str = "</openSubsonicExtensions>";
    const ROOT_END: &str = "</subsonic-response>";
    let mut text = std::str::from_utf8(body).ok()?.to_string();
    if !text.contains("<subsonic-response") || !text.contains("status=\"ok\"") {
        return None;
    }
    for (name, versions) in ours {
        let open = format!("<openSubsonicExtensions name=\"{name}\">");
        match text.find(&open) {
            Some(start) => {
                let inner_start = start + open.len();
                let inner_end = inner_start + text[inner_start..].find(END)?;
                let mut all = Vec::new();
                let mut rest = &text[inner_start..inner_end];
                while !rest.is_empty() {
                    let value = rest.strip_prefix("<versions>")?;
                    let end = value.find("</versions>")?;
                    all.push(value[..end].parse::<u64>().ok()?);
                    rest = &value[end + "</versions>".len()..];
                }
                union(&mut all, versions);
                text.replace_range(start..inner_end + END.len(), &xml_element(name, &all));
            }
            None => {
                // after the last one, or as the answer's only child
                let at = match text.rfind(END) {
                    Some(last) => last + END.len(),
                    None => text.rfind(ROOT_END)?,
                };
                text.insert_str(at, &xml_element(name, versions));
            }
        }
    }
    Some(text.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2-sonus.10 (fb95b5ce)","openSubsonic":true,"openSubsonicExtensions":[{"name":"formPost","versions":[1]},{"name":"songLyrics","versions":[1,2]},{"name":"sonusConnect","versions":[1]},{"name":"sonusDeviceLogin","versions":[1]}]}}"#;
    const XML: &str = r#"<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="navidrome" serverVersion="0.64.2-sonus.10 (fb95b5ce)" openSubsonic="true"><openSubsonicExtensions name="songLyrics"><versions>1</versions><versions>2</versions></openSubsonicExtensions><openSubsonicExtensions name="sonusConnect"><versions>1</versions></openSubsonicExtensions><openSubsonicExtensions name="sonusDeviceLogin"><versions>1</versions></openSubsonicExtensions></subsonic-response>"#;

    fn merged(body: &str, ours: &[(&str, &[u64])]) -> String {
        String::from_utf8(merge(body.as_bytes(), ours).unwrap()).unwrap()
    }

    #[test]
    fn json_gets_the_new_version_and_nothing_else_changes() {
        let expect = JSON.replace(r#"{"name":"sonusConnect","versions":[1]}"#, r#"{"name":"sonusConnect","versions":[1,2]}"#);
        assert_eq!(merged(JSON, OURS), expect);
        // JSONP: the same inside its call
        assert_eq!(merged(&format!("cb({JSON})"), OURS), format!("cb({expect})"));
        // merging again changes nothing
        assert_eq!(merged(&expect, OURS), expect);
    }

    #[test]
    fn xml_gets_the_new_version_and_nothing_else_changes() {
        let expect = XML.replace(
            r#"<openSubsonicExtensions name="sonusConnect"><versions>1</versions></openSubsonicExtensions>"#,
            r#"<openSubsonicExtensions name="sonusConnect"><versions>1</versions><versions>2</versions></openSubsonicExtensions>"#,
        );
        assert_eq!(merged(XML, OURS), expect);
        assert_eq!(merged(&expect, OURS), expect);
    }

    #[test]
    fn an_extension_navidrome_does_not_know_is_added_at_the_end() {
        let ours: &[(&str, &[u64])] = &[("sonusNew", &[1, 3])];
        assert_eq!(
            merged(JSON, ours),
            JSON.replace(
                r#"{"name":"sonusDeviceLogin","versions":[1]}]"#,
                r#"{"name":"sonusDeviceLogin","versions":[1]},{"name":"sonusNew","versions":[1,3]}]"#
            )
        );
        assert_eq!(
            merged(XML, ours),
            XML.replace(
                "</openSubsonicExtensions></subsonic-response>",
                r#"</openSubsonicExtensions><openSubsonicExtensions name="sonusNew"><versions>1</versions><versions>3</versions></openSubsonicExtensions></subsonic-response>"#
            )
        );
        let empty = r#"{"subsonic-response":{"status":"ok","openSubsonicExtensions":[]}}"#;
        assert_eq!(merged(empty, OURS), r#"{"subsonic-response":{"status":"ok","openSubsonicExtensions":[{"name":"sonusConnect","versions":[2]}]}}"#);
    }

    #[test]
    fn names_with_brackets_and_quotes_do_not_confuse_the_list() {
        let odd = r#"{"subsonic-response":{"openSubsonicExtensions":[{"name":"a]\"[","versions":[1]},{"name":"sonusConnect","versions":[1]}],"after":"]"}}"#;
        assert_eq!(merged(odd, OURS), odd.replace(r#"{"name":"sonusConnect","versions":[1]}"#, r#"{"name":"sonusConnect","versions":[1,2]}"#));
    }

    #[test]
    fn what_is_not_a_list_of_extensions_is_left_alone() {
        for body in [
            "",
            "not an answer",
            r#"{"subsonic-response":{"status":"failed","error":{"code":0,"message":"x"}}}"#,
            r#"<subsonic-response xmlns="http://subsonic.org/restapi" status="failed"><error code="0" message="x"></error></subsonic-response>"#,
            r#"{"subsonic-response":{"openSubsonicExtensions":[{"name":"sonusConnect","versions":"one"}]}}"#,
            r#"{"subsonic-response":{"openSubsonicExtensions":[{"name":"x","versions":[1]}"#,
        ] {
            assert_eq!(merge(body.as_bytes(), OURS), None, "{body}");
        }
    }
}
