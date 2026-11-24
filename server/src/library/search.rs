//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! How Navidrome turns what a user typed into a search (`persistence/sql_search.go`, `sql_search_fts.go`,
//! `sql_search_like.go`): nothing typed lists everything in the order of the table; a MusicBrainz id is looked up
//! as one; text with Chinese, Japanese or Korean characters is matched with LIKE (FTS5 does not split it into
//! words); everything else becomes an FTS5 MATCH expression, ranked by BM25, unless nothing searchable is left of it
//! (then LIKE again, or no search at all). The pure part: no database here.

use std::sync::LazyLock;

use regex::Regex;

/// What a query asks the database for (`doSearch`, `getSearchStrategy`).
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// Nothing typed: every row, in the table's natural order.
    Everything,
    /// A MusicBrainz id, lowercased: rows whose MBID columns hold it.
    MusicBrainzId(String),
    /// An FTS5 MATCH expression, without the column filter.
    FullText(String),
    /// Words that must each be in one of the table's main columns (LIKE `%word%`).
    Like(Vec<String>),
    /// Too short or nothing searchable in it: no rows.
    Nothing,
}

/// `searchAll`'s cleaning of the `query` parameter before the repositories see it.
pub fn normalize(query: &str) -> String {
    accents(&go_lower(query.strip_suffix('*').unwrap_or(query)))
}

/// `doSearch` with the FTS5 backend (`Search.Backend` = `fts`, `Search.FullString` off).
pub fn plan(query: &str) -> Plan {
    let q = query.trim();
    let q = q.strip_suffix('*').unwrap_or(q);
    if q.is_empty() || q == "\"\"" {
        return Plan::Everything;
    }
    if is_uuid(q) {
        return Plan::MusicBrainzId(q.to_lowercase());
    }
    if q.len() < 2 {
        return Plan::Nothing;
    }
    if contains_cjk(q) {
        return like(q);
    }
    // newFTSSearch
    let (expression, degraded) = build_fts5_query(q);
    if expression.is_empty() || degraded {
        let cleaned = q.replace('"', "");
        return like(cleaned.trim());
    }
    Plan::FullText(expression)
}

/// `likeSearchExpr`'s words.
fn like(query: &str) -> Plan {
    let words: Vec<String> = query.split_whitespace().map(str::to_string).collect();
    if words.is_empty() { Plan::Nothing } else { Plan::Like(words) }
}

/// Go's `strings.ToLower`: each character's simple lowercase (`İ` becomes `i`, where Rust's full mapping gives `i̇`).
pub fn go_lower(text: &str) -> String {
    text.chars()
        .map(|c| {
            let mut lower = c.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(one), None) => one,
                // the one character whose full lowercase is two: Go's table maps it to plain i
                _ if c == '\u{130}' => 'i',
                _ => c,
            }
        })
        .collect()
}

/// `sanitize.Accents` (github.com/deluan/sanitize): its short list of letters written without their accents.
pub fn accents(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let plain = match c {
            'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ă' => "A",
            'Æ' => "AE",
            'Ç' => "C",
            'È' | 'É' | 'Ê' | 'Ë' => "E",
            'Ì' | 'Í' | 'Î' | 'Ï' => "I",
            'Ð' => "D",
            'Ł' => "L",
            'Ñ' => "N",
            'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' => "O",
            'Œ' => "OE",
            'Ř' => "R",
            'Ś' | 'Ș' | 'Ş' | 'Š' => "S",
            'Ț' => "T",
            'Ù' | 'Ú' | 'Ü' | 'Û' => "U",
            'Ý' => "Y",
            'Þ' => "TH",
            'ẞ' => "SS",
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ă' => "a",
            'æ' => "ae",
            'ç' => "c",
            'è' | 'é' | 'ê' | 'ë' => "e",
            'ì' | 'í' | 'î' | 'ï' => "i",
            'ð' => "d",
            'ł' => "l",
            'ñ' | 'ń' => "n",
            'ò' | 'ó' | 'ô' | 'õ' | 'ō' | 'ö' | 'ø' => "o",
            'œ' => "oe",
            'ř' => "r",
            'ś' | 'ș' | 'ş' | 'š' => "s",
            'ț' => "t",
            'ù' | 'ú' | 'û' | 'ū' | 'ü' => "u",
            'ý' | 'ÿ' => "y",
            'ż' => "z",
            'þ' => "th",
            'ß' => "ss",
            other => {
                out.push(other);
                continue;
            }
        };
        out.push_str(plain);
    }
    out
}

/// `uuid.Validate` (github.com/google/uuid): the 36-character form, the same after `urn:uuid:` or in braces, or 32
/// hexadecimal digits.
fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    let dashed = |b: &[u8]| b.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() });
    match bytes.len() {
        36 => dashed(bytes),
        45 => bytes[..9].eq_ignore_ascii_case(b"urn:uuid:") && dashed(&bytes[9..]),
        38 => bytes[0] == b'{' && bytes[37] == b'}' && dashed(&bytes[1..37]),
        32 => bytes.iter().all(u8::is_ascii_hexdigit),
        _ => false,
    }
}

static CJK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}]").expect("a pattern"));
// Go's \s is the ASCII white space; \b its ASCII word boundary
static FTS5_SPECIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^\\p{L}\\p{N}\\t\\n\\x0c\\r *\"\\x00]").expect("a pattern"));
static FTS5_OPERATORS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)(AND|OR|NOT|NEAR)(?-u:\b)").expect("a pattern"));
static FTS5_LEADING_STAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|[\t\n\x0c\r ])\*+").expect("a pattern"));
/// `str.FTSPunctStrip`: anything that is not a letter or a number.
static PUNCTUATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]").expect("a pattern"));

/// `containsCJK`.
pub fn contains_cjk(text: &str) -> bool {
    CJK.is_match(text)
}

fn is_letter(c: char) -> bool {
    let mut buffer = [0u8; 4];
    !PUNCTUATION.is_match(c.encode_utf8(&mut buffer)) && !c.is_numeric()
}

/// `processPunctuatedWords`: `R.E.M.` becomes the phrase `"R E M"`, `a-ha` becomes `("a ha" OR aha*)`.
fn process_punctuated_words(input: &str, phrases: &mut Vec<String>) -> String {
    const NAME_PUNCTUATION: [char; 5] = ['-', '/', '.', '\'', '\''];
    let mut result: Vec<String> = Vec::new();
    for word in input.split_whitespace() {
        if word.starts_with('\0') || word.contains(['*', '"']) || !word.contains(NAME_PUNCTUATION) {
            result.push(word.to_string());
            continue;
        }
        let concat = PUNCTUATION.replace_all(word, "").into_owned();
        if concat.is_empty() || concat == word {
            result.push(word.to_string());
            continue;
        }
        let spaced = FTS5_SPECIAL.replace_all(word, " ");
        let sub_tokens: Vec<&str> = spaced.split_whitespace().collect();
        if sub_tokens.len() < 2 {
            result.push(concat);
            continue;
        }
        // isDottedAbbreviation: only dots as punctuation, and every part one letter
        let only_dots = word.chars().all(|c| c == '.' || !PUNCTUATION.is_match(c.encode_utf8(&mut [0u8; 4])));
        let single_letters = sub_tokens.iter().all(|token| {
            let mut chars = token.chars();
            matches!((chars.next(), chars.next()), (Some(c), None) if is_letter(c))
        });
        if only_dots && single_letters {
            phrases.push(format!("\"{}\"", sub_tokens.join(" ")));
        } else {
            phrases.push(format!("(\"{}\" OR {concat}*)", sub_tokens.join(" ")));
        }
        result.push(format!("\0PHRASE{}\0", phrases.len() - 1));
    }
    result.join(" ")
}

/// `buildFTS5Query`: a safe FTS5 MATCH expression from what the user typed, and whether too much of it was lost on
/// the way (`ftsQueryDegraded`). Plain words become `(word OR word*)`, joined by AND; quoted phrases and a trailing
/// `*` are kept; FTS5's operators are lowercased into plain words; everything else is stripped.
pub fn build_fts5_query(input: &str) -> (String, bool) {
    let q = input.trim();
    if q.is_empty() || q == "\"\"" {
        return (String::new(), false);
    }
    let mut phrases: Vec<String> = Vec::new();
    let mut result = q.to_string();
    while let Some(start) = result.find('"') {
        let Some(length) = result[start + 1..].find('"') else {
            // a quote without its partner: removed
            result.remove(start);
            break;
        };
        let end = start + 1 + length;
        phrases.push(result[start..=end].to_string());
        result = format!("{}\0PHRASE{}\0{}", &result[..start], phrases.len() - 1, &result[end + 1..]);
    }
    let result = accents(&result);
    let result = FTS5_OPERATORS.replace_all(&result, |found: &regex::Captures| go_lower(&found[0])).into_owned();
    let result = process_punctuated_words(&result, &mut phrases);
    let result = FTS5_SPECIAL.replace_all(&result, " ");
    let result = FTS5_LEADING_STAR.replace_all(&result, "$1");
    let (mut prefix_tokens, mut wrapped_tokens) = (Vec::new(), Vec::new());
    for token in result.split_whitespace() {
        if token.starts_with('\0') || token.ends_with('*') {
            prefix_tokens.push(token.to_string());
            wrapped_tokens.push(token.to_string());
        } else {
            prefix_tokens.push(format!("{token}*"));
            wrapped_tokens.push(format!("({token} OR {token}*)"));
        }
    }
    let (mut prefix_query, mut expression) = (prefix_tokens.join(" "), wrapped_tokens.join(" AND "));
    for (i, phrase) in phrases.iter().enumerate() {
        let placeholder = format!("\0PHRASE{i}\0");
        prefix_query = prefix_query.replace(&placeholder, phrase);
        expression = expression.replace(&placeholder, phrase);
    }
    let degraded = fts_query_degraded(input, &prefix_query);
    (expression, degraded)
}

/// `ftsQueryDegraded`: the query had characters FTS5 drops (`1+`, `C#`), and only very short words are left of it.
pub fn fts_query_degraded(original: &str, fts_query: &str) -> bool {
    let original = original.trim();
    if original.is_empty() || fts_query.is_empty() {
        return false;
    }
    let stripped = original.replace('"', "");
    if PUNCTUATION.replace_all(&stripped, "").len() == stripped.len() {
        return false;
    }
    for token in fts_query.split_whitespace() {
        let token = token.strip_suffix('*').unwrap_or(token);
        if token.starts_with('\0') || token.starts_with('(') {
            return false;
        }
        if token.starts_with('"') {
            let inner = token.trim_matches('"');
            if PUNCTUATION.replace_all(inner, " ").split_whitespace().any(|word| word.len() > 2) {
                return false;
            }
            continue;
        }
        if token.len() > 2 {
            return false;
        }
    }
    true
}

/// A table's FTS5 columns with their BM25 weights (`ftsColumnDefs`), in the order of the FTS table's definition.
fn fts_columns(table: &str) -> &'static [(&'static str, &'static str)] {
    match table {
        "media_file" => &[
            ("title", "10.0"),
            ("album", "5.0"),
            ("artist", "3.0"),
            ("album_artist", "3.0"),
            ("sort_title", "1.0"),
            ("sort_album_name", "1.0"),
            ("sort_artist_name", "1.0"),
            ("sort_album_artist_name", "1.0"),
            ("disc_subtitle", "1.0"),
            ("search_participants", "2.0"),
            ("search_normalized", "1.0"),
        ],
        "album" => &[
            ("name", "10.0"),
            ("sort_album_name", "1.0"),
            ("album_artist", "3.0"),
            ("search_participants", "2.0"),
            ("discs", "1.0"),
            ("catalog_num", "1.0"),
            ("album_version", "1.0"),
            ("search_normalized", "1.0"),
        ],
        "artist" => &[("name", "10.0"), ("sort_artist_name", "1.0"), ("search_normalized", "10.0")],
        _ => &[],
    }
}

/// The MATCH argument for a table: the expression inside the table's column filter (`newFTSSearch`).
pub fn match_argument(table: &str, expression: &str) -> String {
    let names: Vec<&str> = fts_columns(table).iter().map(|(name, _)| *name).collect();
    format!("{{{}}} : ({expression})", names.join(" "))
}

/// The rank a table's matches are ordered by: `bm25(<table>_fts, <weights>)`.
pub fn rank_expression(table: &str) -> String {
    let weights: Vec<&str> = fts_columns(table).iter().map(|(_, weight)| *weight).collect();
    format!("bm25({table}_fts, {})", weights.join(", "))
}

/// The columns a LIKE search looks in (`likeSearchColumns`).
pub fn like_columns(table: &str) -> &'static [&'static str] {
    match table {
        "media_file" => &["title", "album", "artist", "album_artist"],
        "album" => &["name", "album_artist"],
        "artist" => &["name"],
        _ => &[],
    }
}

/// The columns a MusicBrainz id is looked up in (the repositories' `MBIDFields`).
pub fn mbid_columns(table: &str) -> &'static [&'static str] {
    match table {
        "media_file" => &["mbz_recording_id", "mbz_release_track_id"],
        "album" => &["mbz_album_id", "mbz_release_group_id"],
        "artist" => &["mbz_artist_id"],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts5_queries_are_built_as_navidrome_builds_them() {
        // the table of Navidrome's persistence/sql_search_fts_test.go ("buildFTS5Query")
        for (input, expected) in [
            ("", ""),
            ("   ", ""),
            ("beatles", "(beatles OR beatles*)"),
            ("abbey road", "(abbey OR abbey*) AND (road OR road*)"),
            (r#""the beatles""#, r#""the beatles""#),
            ("beat*", "beat*"),
            ("AND OR NOT NEAR", "(and OR and*) AND (or OR or*) AND (not OR not*) AND (near OR near*)"),
            ("test^col:val", "(test OR test*) AND (col OR col*) AND (val OR val*)"),
            (r#""the beatles" abbey"#, r#""the beatles" AND (abbey OR abbey*)"#),
            ("beat* abbey", "beat* AND (abbey OR abbey*)"),
            ("abbey   road", "(abbey OR abbey*) AND (road OR road*)"),
            ("*livia", "(livia OR livia*)"),
            ("*livia oliv*", "(livia OR livia*) AND oliv*"),
            ("*", ""),
            ("Guns N' Roses", "(Guns OR Guns*) AND (N OR N*) AND (Roses OR Roses*)"),
            ("AC/DC", r#"("AC DC" OR ACDC*)"#),
            ("a-ha", r#"("a ha" OR aha*)"#),
            ("a-h", r#"("a h" OR ah*)"#),
            ("Jay-Z", r#"("Jay Z" OR JayZ*)"#),
            ("it's", r#"("it s" OR its*)"#),
            ("best of a-ha", r#"(best OR best*) AND (of OR of*) AND ("a ha" OR aha*)"#),
            ("you've got", r#"("you ve" OR youve*) AND (got OR got*)"#),
            ("rock & roll, vol. 2", "(rock OR rock*) AND (roll OR roll*) AND (vol OR vol*) AND (2 OR 2*)"),
            ("Björk début", "(Bjork OR Bjork*) AND (debut OR debut*)"),
            ("Øystein", "(Oystein OR Oystein*)"),
            ("œuvre", "(oeuvre OR oeuvre*)"),
            ("Brennæ", "(Brennae OR Brennae*)"),
            ("Mø Sigur Rós", "(Mo OR Mo*) AND (Sigur OR Sigur*) AND (Ros OR Ros*)"),
            ("Straße", "(Strasse OR Strasse*)"),
            (r#""Björk""#, r#""Björk""#),
            ("R.E.M.", r#""R E M""#),
            ("R.E.M", r#""R E M""#),
            ("best of R.E.M.", r#"(best OR best*) AND (of OR of*) AND "R E M""#),
            ("U.K.", r#""U K""#),
            ("I am fine", "(I OR I*) AND (am OR am*) AND (fine OR fine*)"),
            ("A test", "(A OR A*) AND (test OR test*)"),
            (r#""ac/dc""#, r#""ac/dc""#),
            (r#""R.E.M.""#, r#""R.E.M.""#),
            ("!!!!!!!", ""),
            ("!@#$%^&", ""),
            (r#""""#, ""),
        ] {
            assert_eq!(build_fts5_query(input).0, expected, "{input:?}");
        }
        // its "degraded flag" table
        for (input, degraded) in [("beatles", false), ("1+", true), ("1+ 2+", true), ("1+ beatles", false), (r#""1+""#, true), ("AC/DC", false), ("", false)] {
            assert_eq!(build_fts5_query(input).1, degraded, "{input:?}");
        }
    }

    #[test]
    fn a_query_that_lost_its_content_is_noticed() {
        // "ftsQueryDegraded"
        for (original, fts, degraded) in [
            ("", "1*", false),
            ("1+", "", false),
            ("beatles", "beatles*", false),
            ("test^val", "test* val*", false),
            (r#""the beatles""#, r#""the beatles""#, false),
            (r#""1+""#, r#""1+""#, true),
            (r#""C++ programming""#, r#""C++ programming""#, false),
            ("1+", "1*", true),
            ("C# 1", "C* 1*", true),
            ("1+ beatles", "1* beatles*", false),
            ("AC/DC", r#"("AC DC" OR ACDC*)"#, false),
        ] {
            assert_eq!(fts_query_degraded(original, fts), degraded, "{original:?} {fts:?}");
        }
    }

    #[test]
    fn chinese_japanese_and_korean_text_is_recognized() {
        // "containsCJK"
        for (input, cjk) in [
            ("", false),
            ("hello world", false),
            ("Björk début", false),
            ("周杰伦", true),
            ("こんにちは", true),
            ("カタカナ", true),
            ("한국어", true),
            ("best of 周杰伦", true),
            ("a曲b", true),
        ] {
            assert_eq!(contains_cjk(input), cjk, "{input:?}");
        }
    }

    #[test]
    fn a_query_is_planned_as_navidromes_dosearch_plans_it() {
        let words = |words: &[&str]| Plan::Like(words.iter().map(|w| w.to_string()).collect());
        assert_eq!(plan(""), Plan::Everything);
        assert_eq!(plan("  "), Plan::Everything);
        assert_eq!(plan("\"\""), Plan::Everything);
        assert_eq!(plan("*"), Plan::Everything);
        assert_eq!(plan("a"), Plan::Nothing, "one character is too broad");
        assert_eq!(plan("é"), Plan::FullText("(e OR e*)".into()), "two bytes pass the length check, as in Go");
        assert_eq!(plan("light"), Plan::FullText("(light OR light*)".into()));
        assert_eq!(plan(" greatest hits* "), Plan::FullText("(greatest OR greatest*) AND (hits OR hits*)".into()));
        assert_eq!(plan("夜行"), words(&["夜行"]));
        assert_eq!(plan("雨の日 夜"), words(&["雨の日", "夜"]));
        assert_eq!(plan("夜"), words(&["夜"]), "a single CJK character is a word");
        assert_eq!(plan("1+"), words(&["1+"]), "what FTS5 would lose is matched with LIKE");
        assert_eq!(plan("!!!"), words(&["!!!"]));
        assert_eq!(plan("\"1+\""), words(&["1+"]));
        assert_eq!(plan("\" \""), Plan::Nothing);
        assert_eq!(plan("0F3D6A8E-5c1b-4d2a-9e7f-1a2b3c4d5f01"), Plan::MusicBrainzId("0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f01".into()));
        assert_eq!(plan("0f3d6a8e5c1b4d2a9e7f1a2b3c4d5f01"), Plan::MusicBrainzId("0f3d6a8e5c1b4d2a9e7f1a2b3c4d5f01".into()));
        assert!(matches!(plan("0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f0"), Plan::FullText(_)), "not an id: words");
        assert!(is_uuid("urn:uuid:0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f01") && is_uuid("{0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f01}"));
        assert!(!is_uuid("0f3d6a8e_5c1b-4d2a-9e7f-1a2b3c4d5f01") && !is_uuid("zf3d6a8e5c1b4d2a9e7f1a2b3c4d5f01"));
    }

    #[test]
    fn the_query_parameter_is_cleaned_as_the_handler_cleans_it() {
        assert_eq!(normalize("Été*"), "ete");
        assert_eq!(normalize("ÜBER"), "uber");
        assert_eq!(normalize("Işık"), "isık", "Go lowercases I to i and leaves the dotless ı");
        assert_eq!(normalize("İnce"), "ince", "Go's İ is a plain i");
        assert_eq!(normalize("Straße"), "strasse");
        assert_eq!(normalize("夜行"), "夜行");
        assert_eq!(go_lower("ΑΣ"), "ασ", "no final-sigma rule in Go's mapping");
    }

    #[test]
    fn match_arguments_and_ranks() {
        // what Navidrome 0.64.2 logs for a search for "light"
        assert_eq!(
            match_argument("media_file", "(light OR light*)"),
            "{title album artist album_artist sort_title sort_album_name sort_artist_name sort_album_artist_name disc_subtitle search_participants search_normalized} : ((light OR light*))"
        );
        assert_eq!(match_argument("artist", "(light OR light*)"), "{name sort_artist_name search_normalized} : ((light OR light*))");
        assert_eq!(rank_expression("media_file"), "bm25(media_file_fts, 10.0, 5.0, 3.0, 3.0, 1.0, 1.0, 1.0, 1.0, 1.0, 2.0, 1.0)");
        assert_eq!(rank_expression("album"), "bm25(album_fts, 10.0, 1.0, 3.0, 2.0, 1.0, 1.0, 1.0, 1.0)");
        assert_eq!(rank_expression("artist"), "bm25(artist_fts, 10.0, 1.0, 10.0)");
    }
}
