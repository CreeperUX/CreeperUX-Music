//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! The library's queries, as Navidrome's repositories make them (`persistence/album_repository.go`,
//! `mediafile_repository.go`, `sql_base_repository.go`, `sql_annotations.go`, `artwork_hydration.go`): the same
//! SQL text, so SQLite answers with the same rows in the same order; the signed-in user's annotations joined in;
//! what the user may see; and the sort orders with the settings that change them.
//!
//! Read-only. Nothing is kept between requests: Navidrome and its scanner write these tables.

use std::collections::HashMap;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, Row, params_from_iter};

use crate::config::LibraryOptions;
use crate::gotime;

/// The signed-in user, as far as the library's queries need them (Navidrome's `model.User` in the request context).
#[derive(Debug, Clone, PartialEq)]
pub struct Viewer {
    pub id: String,
    pub name: String,
    pub is_admin: bool,
    /// The libraries granted to the user (`user_library`), as Navidrome loads them with the user.
    pub libraries: Vec<i64>,
    /// How many libraries there are.
    pub all_libraries: i64,
}

impl Viewer {
    /// Navidrome's `FindByUsername`, by id: None when the user is gone.
    pub fn load(conn: &Connection, user_id: &str) -> rusqlite::Result<Option<Viewer>> {
        let mut found = conn.prepare_cached("SELECT user_name, is_admin FROM user WHERE id = ?1")?;
        let mut rows = found.query([user_id])?;
        let Some(row) = rows.next()? else { return Ok(None) };
        let (name, is_admin) = (text(row, 0), truthy(row.get_ref(1)?));
        let mut granted =
            conn.prepare_cached("SELECT library.id FROM user_library ul JOIN library ON ul.library_id = library.id WHERE ul.user_id = ?1 ORDER BY library.id")?;
        let libraries = granted.query_map([user_id], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let all_libraries = conn.query_row("SELECT count(distinct library.id) FROM library", [], |r| r.get(0))?;
        Ok(Some(Viewer { id: user_id.to_string(), name, is_admin, libraries, all_libraries }))
    }

    /// Navidrome's `applyLibraryFilter`: nothing for an admin and for a user granted every library, else the
    /// subquery over `user_library`.
    fn library_filter(&self, table: &str) -> Option<Cond> {
        if self.is_admin || (self.all_libraries > 0 && self.libraries.len() as i64 == self.all_libraries) {
            return None;
        }
        Some(Cond::new(format!("{table}.library_id IN (SELECT ul.library_id FROM user_library ul WHERE ul.user_id = ?)"), vec![Value::Text(self.id.clone())]))
    }

    /// The Subsonic handlers' `selectedMusicFolderIds` without a `musicFolderId`: the user's libraries, as the
    /// filter `filter.ApplyLibraryFilter` adds (none when the user has no library).
    pub fn music_folders(&self) -> Option<Cond> {
        if self.libraries.is_empty() {
            return None;
        }
        Some(Cond::is_in("library_id", self.libraries.iter().map(|id| Value::Integer(*id)).collect()))
    }
}

/// A condition with its arguments (squirrel's `Sqlizer`).
#[derive(Debug, Clone, PartialEq)]
pub struct Cond {
    pub sql: String,
    pub args: Vec<Value>,
}

impl Cond {
    pub fn new(sql: impl Into<String>, args: Vec<Value>) -> Cond {
        Cond { sql: sql.into(), args }
    }

    /// squirrel's `Eq{column: value}`.
    pub fn eq(column: &str, value: Value) -> Cond {
        Cond::new(format!("{column} = ?"), vec![value])
    }

    /// squirrel's `Gt`, `GtOrEq`, `LtOrEq`.
    pub fn compare(column: &str, operator: &str, value: Value) -> Cond {
        Cond::new(format!("{column} {operator} ?"), vec![value])
    }

    /// squirrel's `Eq{column: []values}`.
    pub fn is_in(column: &str, values: Vec<Value>) -> Cond {
        if values.is_empty() {
            return Cond::new("(1=0)", Vec::new()); // squirrel's answer to an empty list
        }
        let marks = vec!["?"; values.len()].join(",");
        Cond::new(format!("{column} IN ({marks})"), values)
    }

    /// squirrel's `And{…}`: in brackets, joined by AND.
    pub fn and(parts: Vec<Cond>) -> Cond {
        Cond::join(parts, " AND ")
    }

    /// squirrel's `Or{…}`.
    pub fn or(parts: Vec<Cond>) -> Cond {
        Cond::join(parts, " OR ")
    }

    fn join(parts: Vec<Cond>, with: &str) -> Cond {
        let sql = format!("({})", parts.iter().map(|p| p.sql.as_str()).collect::<Vec<_>>().join(with));
        Cond { sql, args: parts.into_iter().flat_map(|p| p.args).collect() }
    }

    /// `filter.addDefaultFilters`: what is missing from the disk is not shown.
    pub fn not_missing(self) -> Cond {
        Cond::and(vec![Cond::eq("missing", Value::Integer(0)), self])
    }
}

/// `missing = false` alone.
pub fn not_missing() -> Cond {
    Cond::eq("missing", Value::Integer(0))
}

/// A list's options (Navidrome's `model.QueryOptions`).
#[derive(Debug, Clone, Default)]
pub struct ListOptions {
    pub filter: Option<Cond>,
    /// The ORDER BY, already built (`build_sort_order`); None: none.
    pub order_by: Option<String>,
    /// Navidrome applies a limit and an offset only when they are positive.
    pub max: i64,
    pub offset: i64,
}

/// Which table's sort mappings (`setSortMappings` in the two repositories).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Table {
    Album,
    MediaFile,
}

impl Table {
    pub fn name(self) -> &'static str {
        match self {
            Table::Album => "album",
            Table::MediaFile => "media_file",
        }
    }
}

/// `naturalSort`.
fn natural_sort(column: &str, options: &LibraryOptions) -> String {
    if options.enable_natural_sorting { format!("({column} collate NATSORT)") } else { column.to_string() }
}

/// The repositories' sort mappings: the columns a sort key stands for, None for a key they do not map.
fn sort_mapping_for(table: Table, key: &str, options: &LibraryOptions) -> Option<String> {
    let by_mod_time = options.recently_added_by_mod_time;
    let mapped = match (table, key) {
        (Table::Album, "name") => "order_album_name, order_album_artist_name".to_string(),
        (Table::Album, "artist" | "album_artist") => "compilation, order_album_artist_name, order_album_name".to_string(),
        (Table::Album, "max_year") => {
            format!("coalesce(nullif(original_date,''), cast(max_year as text)), release_date, {}", natural_sort("album.name", options))
        }
        (Table::Album, "recently_added") => if by_mod_time { "album.updated_at, album.id" } else { "album.created_at, album.id" }.to_string(),
        (Table::MediaFile, "title") => "order_title".to_string(),
        (Table::MediaFile, "artist") => "order_artist_name, order_album_name, release_date, disc_number, track_number".to_string(),
        (Table::MediaFile, "album_artist") => "order_album_artist_name, order_album_name, release_date, disc_number, track_number".to_string(),
        (Table::MediaFile, "album") => {
            format!("order_album_name, album_id, disc_number, track_number, order_artist_name, {}", natural_sort("media_file.title", options))
        }
        (Table::MediaFile, "created_at") => "media_file.created_at".to_string(),
        (Table::MediaFile, "recently_added") => {
            if by_mod_time { "media_file.updated_at, media_file.id" } else { "media_file.created_at, media_file.id" }.to_string()
        }
        (Table::MediaFile, "year" | "genre" | "duration" | "channels" | "bpm" | "path" | "comment" | "play_count" | "play_date" | "rating") => key.to_string(),
        (_, "random") => "random".to_string(),
        (_, "starred_at") => "starred, starred_at".to_string(),
        (_, "rated_at") => "rating, rated_at".to_string(),
        _ => return None,
    };
    // setSortMappings: with either setting, the order_* columns of every mapping become collated expressions
    Some(if options.prefer_sort_tags || options.enable_natural_sorting { map_sort_order(table.name(), &mapped, options) } else { mapped })
}

/// `mapSortOrder`: `order_x` → `(album.order_x collate nocase)`, with the sort tag first when those are preferred,
/// and the natural collation when that is on. Lowercases the whole mapping, as Navidrome does.
fn map_sort_order(table: &str, order: &str, options: &LibraryOptions) -> String {
    let order = order.to_lowercase();
    let collation = if options.enable_natural_sorting { "NATSORT" } else { "nocase" };
    let mut out = String::with_capacity(order.len() * 2);
    let mut rest = order.as_str();
    // the regexp `order_([a-z_]+)`, leftmost and longest
    while let Some(at) = rest.find("order_") {
        let name_from = at + "order_".len();
        let name_len = rest[name_from..].bytes().take_while(|b| b.is_ascii_lowercase() || *b == b'_').count();
        if name_len == 0 {
            out.push_str(&rest[..name_from]);
            rest = &rest[name_from..];
            continue;
        }
        let name = &rest[name_from..name_from + name_len];
        out.push_str(&rest[..at]);
        let column =
            if options.prefer_sort_tags { format!("coalesce(nullif({table}.sort_{name},''),{table}.order_{name})") } else { format!("{table}.order_{name}") };
        out.push_str(&format!("({column} collate {collation})"));
        rest = &rest[name_from + name_len..];
    }
    out.push_str(rest);
    out
}

/// Go's `toSnakeCase` (`persistence/helpers.go`): `playDate` → `play_date`.
fn to_snake_case(text: &str) -> String {
    // (.)([A-Z][a-z]+) → $1_$2, then ([a-z0-9])([A-Z]) → $1_$2, then lowercased
    let chars: Vec<char> = text.chars().collect();
    let mut first = String::with_capacity(text.len() + 4);
    let mut i = 0;
    while i < chars.len() {
        // a match is any character, then a capital with at least one lowercase letter after it
        if i + 2 < chars.len() && chars[i] != '\n' && chars[i + 1].is_ascii_uppercase() && chars[i + 2].is_ascii_lowercase() {
            first.push(chars[i]);
            first.push('_');
            first.push(chars[i + 1]);
            i += 2;
            while i < chars.len() && chars[i].is_ascii_lowercase() {
                first.push(chars[i]);
                i += 1;
            }
            continue;
        }
        first.push(chars[i]);
        i += 1;
    }
    let chars: Vec<char> = first.chars().collect();
    let mut second = String::with_capacity(first.len() + 4);
    let mut i = 0;
    while i < chars.len() {
        second.push(chars[i]);
        if i + 1 < chars.len() && (chars[i].is_ascii_lowercase() || chars[i].is_ascii_digit()) && chars[i + 1].is_ascii_uppercase() {
            second.push('_');
            second.push(chars[i + 1]);
            i += 2;
            continue;
        }
        i += 1;
    }
    second.to_lowercase()
}

/// Go's `toCamelCase`: `play_date` → `playDate`.
fn to_camel_case(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match chars.peek() {
            Some(next) if c == '_' && next.is_ascii_alphabetic() => {
                out.push(next.to_ascii_uppercase());
                chars.next();
            }
            _ => out.push(c),
        }
    }
    out
}

/// Splits at `delimiter` outside brackets (Go's `strings.FieldsFunc` with `splitFunc`): empty fields are dropped.
fn split_outside_brackets(text: &str, delimiter: char) -> Vec<&str> {
    let mut fields = Vec::new();
    let (mut open, mut start) = (0i32, None);
    for (at, c) in text.char_indices() {
        let splits = if c == '(' {
            open += 1;
            false
        } else if open > 0 {
            if c == ')' {
                open -= 1;
            }
            false
        } else {
            c == delimiter
        };
        match (splits, start) {
            (true, Some(from)) => {
                fields.push(&text[from..at]);
                start = None;
            }
            (false, None) => start = Some(at),
            _ => {}
        }
    }
    if let Some(from) = start {
        fields.push(&text[from..]);
    }
    fields
}

/// `sqlRepository.sortMapping`: the whole key, else each comma-separated part on its own, mapped or snake-cased.
fn sort_mapping(table: Table, sort: &str, options: &LibraryOptions) -> String {
    let lookup = |key: &str| {
        sort_mapping_for(table, key, options)
            .or_else(|| sort_mapping_for(table, &to_camel_case(key), options))
            .or_else(|| sort_mapping_for(table, &to_snake_case(key), options))
    };
    if let Some(mapping) = lookup(sort) {
        return mapping;
    }
    split_outside_brackets(sort, ',')
        .into_iter()
        .map(|part| {
            let part = part.trim();
            lookup(part).unwrap_or_else(|| to_snake_case(part))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `sqlRepository.buildSortOrder`: every column gets a direction, turned around where the mapping says `desc`.
pub fn build_sort_order(table: Table, sort: &str, order: &str, options: &LibraryOptions) -> String {
    let sort = sort_mapping(table, sort, options);
    let (order, reverse) = if order.trim().eq_ignore_ascii_case("desc") { ("desc", "asc") } else { ("asc", "desc") };
    split_outside_brackets(&sort, ',')
        .into_iter()
        .filter_map(|part| {
            let fields = split_outside_brackets(part, ' ');
            let column = fields.first()?;
            let direction = match fields.get(1) {
                None => order,
                Some(&"asc") => order,
                Some(_) => reverse,
            };
            Some(format!("{column} {direction}"))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `withAnnotation`'s join and columns for a table.
fn annotation_join(table: &str) -> String {
    format!("LEFT JOIN annotation on (annotation.item_id = {table}.id AND annotation.item_type = ? AND annotation.user_id = ?)")
}

fn annotation_columns(table: &str, options: &LibraryOptions) -> String {
    let play_count = if options.normalized_album_play_count && table == "album" {
        "round(coalesce(round(cast(play_count as float) / coalesce(album.song_count, 1), 1), 0)) as play_count"
    } else {
        "coalesce(play_count, 0) as play_count"
    };
    format!("coalesce(starred, 0) as starred, coalesce(rating, 0) as rating, starred_at, play_date, rated_at, {play_count}, {table}.average_rating")
}

/// WHERE, ORDER BY, LIMIT and OFFSET as squirrel writes them for `newSelect(options)` plus the library filter.
fn tail(list: &ListOptions, library: Option<Cond>, args: &mut Vec<Value>) -> String {
    let mut sql = String::new();
    let conditions: Vec<&Cond> = list.filter.iter().chain(library.iter()).collect();
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.iter().map(|c| c.sql.as_str()).collect::<Vec<_>>().join(" AND "));
        for c in conditions {
            args.extend(c.args.iter().cloned());
        }
    }
    if let Some(order_by) = list.order_by.as_deref().filter(|o| !o.is_empty()) {
        sql.push_str(" ORDER BY ");
        sql.push_str(order_by);
    }
    if list.max > 0 {
        sql.push_str(&format!(" LIMIT {}", list.max));
    }
    if list.offset > 0 {
        // without a LIMIT SQLite refuses this, from Navidrome's builder too: callers hand such a list to Navidrome
        sql.push_str(&format!(" OFFSET {}", list.offset));
    }
    sql
}

/// An album, as Navidrome's `model.Album` after `dbAlbum.PostScan` and the artwork hydration.
#[derive(Debug, Clone, Default)]
pub struct Album {
    pub id: String,
    pub name: String,
    pub album_artist: String,
    pub album_artist_id: String,
    pub max_year: i64,
    pub max_original_year: i64,
    pub original_date: String,
    pub release_date: String,
    pub compilation: bool,
    pub song_count: i64,
    pub duration: f64,
    pub discs: Vec<(i64, String)>,
    pub sort_album_name: String,
    pub order_album_name: String,
    pub mbz_album_id: String,
    pub explicit_status: String,
    pub genre: String,
    pub tags: Tags,
    pub participants: Participants,
    pub imported_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub annotations: Annotations,
    pub image: ItemImage,
}

/// A song, as Navidrome's `model.MediaFile` after `dbMediaFile.PostScan` and the artwork hydration.
#[derive(Debug, Clone, Default)]
pub struct Song {
    pub id: String,
    pub library_path: String,
    pub path: String,
    pub title: String,
    pub album: String,
    pub artist_id: String,
    pub artist: String,
    pub album_artist: String,
    pub album_id: String,
    pub has_cover_art: bool,
    pub track_number: i64,
    pub disc_number: i64,
    pub year: i64,
    pub size: i64,
    pub suffix: String,
    pub duration: f64,
    pub bit_rate: i64,
    pub sample_rate: i64,
    pub bit_depth: Option<i64>,
    pub channels: i64,
    pub genre: String,
    pub sort_title: String,
    pub order_title: String,
    pub comment: String,
    pub bpm: Option<i64>,
    pub explicit_status: String,
    pub mbz_recording_id: String,
    pub rg_album_gain: Option<f64>,
    pub rg_album_peak: Option<f64>,
    pub rg_track_gain: Option<f64>,
    pub rg_track_peak: Option<f64>,
    pub lyrics: String,
    pub tags: Tags,
    pub participants: Participants,
    pub birth_time: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub annotations: Annotations,
    pub bookmark_position: i64,
    /// The song's own artwork state, and its album's (`MediaFile.ItemImage`, `MediaFile.AlbumImage`).
    pub image: ItemImage,
    pub album_image: ItemImage,
}

/// `model.Annotations`: the signed-in user's.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Annotations {
    pub play_count: i64,
    pub play_date: Option<String>,
    pub rating: i64,
    pub starred: bool,
    pub starred_at: Option<String>,
    pub average_rating: f64,
}

/// `model.ItemImage`, the two fields the Subsonic answers use.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ItemImage {
    pub hash: String,
    pub absent: bool,
}

/// `model.Tags`: a tag's values in the order the database has them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tags(pub Vec<(String, Vec<String>)>);

impl Tags {
    pub fn values(&self, name: &str) -> &[String] {
        self.0.iter().find(|(tag, _)| tag == name).map(|(_, values)| values.as_slice()).unwrap_or(&[])
    }

    pub fn first(&self, name: &str) -> Option<&str> {
        self.values(name).first().map(String::as_str)
    }
}

/// One artist of a role (`model.Participant`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Participant {
    pub id: String,
    pub name: String,
    pub sub_role: String,
}

/// `model.Participants`: the roles sorted by name (Go keeps them in a map, in no order).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Participants(pub Vec<(String, Vec<Participant>)>);

impl Participants {
    pub fn role(&self, role: &str) -> &[Participant] {
        self.0.iter().find(|(name, _)| name == role).map(|(_, list)| list.as_slice()).unwrap_or(&[])
    }
}

/// Navidrome's roles (`model.AllRoles`): participants of any other make its JSON decoding fail.
const ROLES: [&str; 14] = [
    "artist",
    "albumartist",
    "composer",
    "conductor",
    "lyricist",
    "arranger",
    "producer",
    "director",
    "engineer",
    "mixer",
    "remixer",
    "djmixer",
    "performer",
    "maincredit",
];

/// A row Navidrome would fail to read, or that this port does not read as Go's decoders do: the request goes to
/// Navidrome instead.
#[derive(Debug)]
pub enum QueryError {
    Sqlite(rusqlite::Error),
    /// What was not understood.
    Unreadable(String),
}

impl From<rusqlite::Error> for QueryError {
    fn from(e: rusqlite::Error) -> Self {
        QueryError::Sqlite(e)
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QueryError::Sqlite(e) => write!(f, "{e}"),
            QueryError::Unreadable(what) => write!(f, "{what}"),
        }
    }
}

type QueryResult<T> = Result<T, QueryError>;

/// `unmarshalTags`: `{"genre":[{"id":"…","value":"Rock"}]}`.
fn parse_tags(data: &str) -> QueryResult<Tags> {
    let unreadable = || QueryError::Unreadable("tags that are not Navidrome's JSON".into());
    let json: serde_json::Value = serde_json::from_str(data).map_err(|_| unreadable())?;
    let serde_json::Value::Object(object) = json else {
        return if json.is_null() { Ok(Tags::default()) } else { Err(unreadable()) };
    };
    let mut tags = Vec::with_capacity(object.len());
    for (name, list) in object {
        let values = match list {
            serde_json::Value::Null => Vec::new(),
            serde_json::Value::Array(items) => items
                .into_iter()
                .map(|item| match item.get("value") {
                    Some(serde_json::Value::String(value)) => Ok(value.clone()),
                    None | Some(serde_json::Value::Null) if item.is_object() => Ok(String::new()),
                    _ => Err(unreadable()),
                })
                .collect::<QueryResult<Vec<_>>>()?,
            _ => return Err(unreadable()),
        };
        tags.push((name, values));
    }
    Ok(Tags(tags))
}

/// `unmarshalParticipants`: `{"artist":[{"id":"…","name":"…","subRole":"…"}]}`.
fn parse_participants(data: &str) -> QueryResult<Participants> {
    let unreadable = || QueryError::Unreadable("participants that are not Navidrome's JSON".into());
    let json: serde_json::Value = serde_json::from_str(data).map_err(|_| unreadable())?;
    let serde_json::Value::Object(object) = json else {
        return if json.is_null() { Ok(Participants::default()) } else { Err(unreadable()) };
    };
    let text = |item: &serde_json::Value, key: &str| match item.get(key) {
        Some(serde_json::Value::String(value)) => Ok(value.clone()),
        None | Some(serde_json::Value::Null) => Ok(String::new()),
        _ => Err(unreadable()),
    };
    let mut roles = Vec::with_capacity(object.len());
    for (role, list) in object {
        if !ROLES.contains(&role.as_str()) {
            return Err(QueryError::Unreadable(format!("participants with a role Navidrome does not know ({role})")));
        }
        let artists = match list {
            serde_json::Value::Null => Vec::new(),
            serde_json::Value::Array(items) => items
                .iter()
                .map(|item| {
                    if !item.is_object() {
                        return Err(unreadable());
                    }
                    Ok(Participant { id: text(item, "id")?, name: text(item, "name")?, sub_role: text(item, "subRole")? })
                })
                .collect::<QueryResult<Vec<_>>>()?,
            _ => return Err(unreadable()),
        };
        roles.push((role, artists));
    }
    Ok(Participants(roles))
}

/// An album's `discs`: `{"1":"Day","2":"Night"}`.
fn parse_discs(data: &str) -> QueryResult<Vec<(i64, String)>> {
    let unreadable = || QueryError::Unreadable("discs that are not Navidrome's JSON".into());
    let json: serde_json::Value = serde_json::from_str(data).map_err(|_| unreadable())?;
    let serde_json::Value::Object(object) = json else {
        return if json.is_null() { Ok(Vec::new()) } else { Err(unreadable()) };
    };
    object
        .into_iter()
        .map(|(number, title)| {
            let number = number.parse::<i64>().map_err(|_| unreadable())?;
            match title {
                serde_json::Value::String(title) => Ok((number, title)),
                serde_json::Value::Null => Ok((number, String::new())),
                _ => Err(unreadable()),
            }
        })
        .collect()
}

// Columns, read as Go's database/sql and dbx read them into the model's fields: NULL is the zero value.

fn text<I: rusqlite::RowIndex>(row: &Row, column: I) -> String {
    match row.get_ref(column) {
        Ok(ValueRef::Text(bytes)) | Ok(ValueRef::Blob(bytes)) => String::from_utf8_lossy(bytes).into_owned(),
        Ok(ValueRef::Integer(n)) => n.to_string(),
        Ok(ValueRef::Real(x)) => x.to_string(),
        _ => String::new(),
    }
}

fn integer(value: ValueRef) -> i64 {
    match value {
        ValueRef::Integer(n) => n,
        ValueRef::Real(x) => x as i64,
        ValueRef::Text(bytes) => std::str::from_utf8(bytes).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0),
        _ => 0,
    }
}

fn int(row: &Row, column: &str) -> i64 {
    row.get_ref(column).map(integer).unwrap_or(0)
}

fn optional_int(row: &Row, column: &str) -> Option<i64> {
    match row.get_ref(column) {
        Ok(ValueRef::Null) | Err(_) => None,
        Ok(value) => Some(integer(value)),
    }
}

fn real(value: ValueRef) -> f64 {
    match value {
        ValueRef::Real(x) => x,
        ValueRef::Integer(n) => n as f64,
        ValueRef::Text(bytes) => std::str::from_utf8(bytes).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0.0),
        _ => 0.0,
    }
}

fn float(row: &Row, column: &str) -> f64 {
    row.get_ref(column).map(real).unwrap_or(0.0)
}

fn optional_float(row: &Row, column: &str) -> Option<f64> {
    match row.get_ref(column) {
        Ok(ValueRef::Null) | Err(_) => None,
        Ok(value) => Some(real(value)),
    }
}

fn truthy(value: ValueRef) -> bool {
    match value {
        ValueRef::Integer(n) => n != 0,
        ValueRef::Real(x) => x != 0.0,
        ValueRef::Text(bytes) => matches!(bytes, b"1" | b"t" | b"T" | b"true" | b"TRUE" | b"True"),
        _ => false,
    }
}

fn boolean(row: &Row, column: &str) -> bool {
    row.get_ref(column).map(truthy).unwrap_or(false)
}

/// A time column for a JSON answer, as Go's driver reads it and `time.Time` marshals it; None for NULL and for text
/// the driver reads as the zero time.
fn time(row: &Row, column: &str) -> Option<String> {
    match row.get_ref(column) {
        Ok(ValueRef::Text(bytes)) => gotime::stored_to_json(std::str::from_utf8(bytes).ok()?).filter(|t| !t.starts_with("0001-01-01T00:00:00")),
        _ => None,
    }
}

fn annotations(row: &Row) -> Annotations {
    Annotations {
        play_count: int(row, "play_count"),
        play_date: time(row, "play_date"),
        rating: int(row, "rating"),
        starred: boolean(row, "starred"),
        starred_at: time(row, "starred_at"),
        average_rating: float(row, "average_rating"),
    }
}

fn album_from(row: &Row) -> QueryResult<Album> {
    let tags_text = text(row, "tags");
    let (mut genre, mut tags) = (text(row, "genre"), Tags::default());
    if !tags_text.is_empty() {
        tags = parse_tags(&tags_text)?;
        // dbAlbum.PostScan: the genre is the first genre tag, whatever the column says
        genre = tags.first("genre").unwrap_or("").to_string();
    }
    let discs_text = text(row, "discs");
    Ok(Album {
        id: text(row, "id"),
        name: text(row, "name"),
        album_artist: text(row, "album_artist"),
        album_artist_id: text(row, "album_artist_id"),
        max_year: int(row, "max_year"),
        max_original_year: int(row, "max_original_year"),
        original_date: text(row, "original_date"),
        release_date: text(row, "release_date"),
        compilation: boolean(row, "compilation"),
        song_count: int(row, "song_count"),
        duration: float(row, "duration"),
        discs: if discs_text.is_empty() { Vec::new() } else { parse_discs(&discs_text)? },
        sort_album_name: text(row, "sort_album_name"),
        order_album_name: text(row, "order_album_name"),
        mbz_album_id: text(row, "mbz_album_id"),
        explicit_status: text(row, "explicit_status"),
        genre,
        tags,
        participants: parse_participants(&text(row, "participants"))?,
        imported_at: time(row, "imported_at"),
        created_at: time(row, "created_at"),
        updated_at: time(row, "updated_at"),
        annotations: annotations(row),
        image: ItemImage::default(),
    })
}

fn song_from(row: &Row) -> QueryResult<Song> {
    let tags_text = text(row, "tags");
    let (mut genre, mut tags) = (text(row, "genre"), Tags::default());
    if !tags_text.is_empty() {
        tags = parse_tags(&tags_text)?;
        genre = tags.first("genre").unwrap_or("").to_string();
    }
    Ok(Song {
        id: text(row, "id"),
        library_path: text(row, "library_path"),
        path: text(row, "path"),
        title: text(row, "title"),
        album: text(row, "album"),
        artist_id: text(row, "artist_id"),
        artist: text(row, "artist"),
        album_artist: text(row, "album_artist"),
        album_id: text(row, "album_id"),
        has_cover_art: boolean(row, "has_cover_art"),
        track_number: int(row, "track_number"),
        disc_number: int(row, "disc_number"),
        year: int(row, "year"),
        size: int(row, "size"),
        suffix: text(row, "suffix"),
        duration: float(row, "duration"),
        bit_rate: int(row, "bit_rate"),
        sample_rate: int(row, "sample_rate"),
        bit_depth: optional_int(row, "bit_depth"),
        channels: int(row, "channels"),
        genre,
        sort_title: text(row, "sort_title"),
        order_title: text(row, "order_title"),
        comment: text(row, "comment"),
        bpm: optional_int(row, "bpm"),
        explicit_status: text(row, "explicit_status"),
        mbz_recording_id: text(row, "mbz_recording_id"),
        rg_album_gain: optional_float(row, "rg_album_gain"),
        rg_album_peak: optional_float(row, "rg_album_peak"),
        rg_track_gain: optional_float(row, "rg_track_gain"),
        rg_track_peak: optional_float(row, "rg_track_peak"),
        lyrics: text(row, "lyrics"),
        tags,
        participants: parse_participants(&text(row, "participants"))?,
        birth_time: time(row, "birth_time"),
        created_at: time(row, "created_at"),
        updated_at: time(row, "updated_at"),
        annotations: annotations(row),
        bookmark_position: int(row, "bookmark_position"),
        image: ItemImage::default(),
        album_image: ItemImage::default(),
    })
}

/// `albumRepository.GetAll`: the albums of a list, with the user's annotations and the artwork state.
pub fn albums(conn: &Connection, viewer: &Viewer, options: &LibraryOptions, list: &ListOptions) -> QueryResult<Vec<Album>> {
    let mut args = vec![Value::Text("album".into()), Value::Text(viewer.id.clone())];
    let sql = format!(
        "SELECT album.*, library.path as library_path, library.name as library_name, {} FROM album LEFT JOIN library on album.library_id = library.id {}{}",
        annotation_columns("album", options),
        annotation_join("album"),
        tail(list, viewer.library_filter("album"), &mut args)
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let mut rows = statement.query(params_from_iter(args))?;
    let mut albums = Vec::new();
    while let Some(row) = rows.next()? {
        albums.push(album_from(row)?);
    }
    let images = item_images(conn, "al", albums.iter().map(|a| a.id.as_str()))?;
    for album in &mut albums {
        if let Some(image) = images.get(&album.id) {
            album.image = image.clone();
        }
    }
    Ok(albums)
}

/// `albumRepository.CountAll`: how many albums a list's filter matches, whatever its paging. `annotated`: the
/// filter names an annotation column (Navidrome joins the annotations only then).
pub fn count_albums(conn: &Connection, viewer: &Viewer, filter: Option<&Cond>, annotated: bool) -> QueryResult<i64> {
    let mut args = Vec::new();
    let mut sql = String::from("SELECT count(distinct album.id) as count FROM album");
    if annotated {
        sql.push(' ');
        sql.push_str(&annotation_join("album"));
        args.extend([Value::Text("album".into()), Value::Text(viewer.id.clone())]);
    }
    let conditions: Vec<Cond> = viewer.library_filter("album").into_iter().chain(filter.cloned()).collect();
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.iter().map(|c| c.sql.as_str()).collect::<Vec<_>>().join(" AND "));
        args.extend(conditions.into_iter().flat_map(|c| c.args));
    }
    sql.push_str(" ORDER BY album.id");
    Ok(conn.prepare_cached(&sql)?.query_row(params_from_iter(args), |r| r.get(0))?)
}

/// The ids of the albums a filter matches, for the lists whose order is made here (the random one).
pub fn album_ids(conn: &Connection, viewer: &Viewer, filter: Option<&Cond>) -> QueryResult<Vec<String>> {
    let mut args = Vec::new();
    let list = ListOptions { filter: filter.cloned(), ..ListOptions::default() };
    let sql = format!("SELECT album.id FROM album{}", tail(&list, viewer.library_filter("album"), &mut args));
    let mut statement = conn.prepare_cached(&sql)?;
    let ids = statement.query_map(params_from_iter(args), |r| Ok(text(r, 0)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// `mediaFileRepository.GetAll`: the songs of a list, with the user's annotations and bookmark and the artwork state.
pub fn songs(conn: &Connection, viewer: &Viewer, options: &LibraryOptions, list: &ListOptions) -> QueryResult<Vec<Song>> {
    let mut args = vec![Value::Text("media_file".into()), Value::Text(viewer.id.clone()), Value::Text(viewer.id.clone())];
    // Navidrome writes the user's id into the bookmark join as a literal; here it is an argument
    let sql = format!(
        "SELECT media_file.*, library.path as library_path, library.name as library_name, {}, coalesce(position, 0) as bookmark_position FROM media_file \
         LEFT JOIN library on media_file.library_id = library.id {} LEFT JOIN bookmark on (bookmark.item_id = media_file.id AND bookmark.user_id = ?){}",
        annotation_columns("media_file", options),
        annotation_join("media_file"),
        tail(list, viewer.library_filter("media_file"), &mut args)
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let mut rows = statement.query(params_from_iter(args))?;
    let mut songs = Vec::new();
    while let Some(row) = rows.next()? {
        songs.push(song_from(row)?);
    }
    hydrate_song_artwork(conn, options, &mut songs)?;
    Ok(songs)
}

/// `artworkRepository.GetInfoForItems`: the resolved artwork state of items of one kind (`al`, `mf`), by item id. An
/// item without a row is unresolved; a row with an empty hash means the item is known to have no picture.
pub fn item_images<'a>(conn: &Connection, kind: &str, ids: impl Iterator<Item = &'a str>) -> QueryResult<HashMap<String, ItemImage>> {
    let ids: Vec<&str> = ids.collect();
    let mut found = HashMap::new();
    // Navidrome asks in batches too, under SQLite's limit on arguments
    for chunk in ids.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT ia.item_id, ia.hash FROM item_artwork ia WHERE (ia.item_kind = ? AND ia.image_type = ? AND ia.item_id IN ({marks}))");
        let args = [kind, "primary"].into_iter().chain(chunk.iter().copied());
        let mut statement = conn.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(args))?;
        while let Some(row) = rows.next()? {
            let hash = text(row, 1);
            found.insert(text(row, 0), ItemImage { absent: hash.is_empty(), hash });
        }
    }
    Ok(found)
}

/// `hydrateMediaFileArtwork`: a song with resolved art of its own uses it, else it falls back to its album's.
pub fn hydrate_song_artwork(conn: &Connection, options: &LibraryOptions, songs: &mut [Song]) -> QueryResult<()> {
    if songs.is_empty() {
        return Ok(());
    }
    let eligible = |song: &Song| song.has_cover_art && options.enable_media_file_cover_art;
    let albums = item_images(conn, "al", songs.iter().map(|s| s.album_id.as_str()))?;
    let own = item_images(conn, "mf", songs.iter().filter(|s| eligible(s)).map(|s| s.id.as_str()))?;
    for song in songs {
        let album = albums.get(&song.album_id);
        if let Some(album) = album {
            song.album_image = album.clone();
        }
        let eligible = eligible(song);
        let resolved = own.get(&song.id);
        if let Some(own) = resolved.filter(|own| eligible && !own.absent) {
            song.image = own.clone();
            continue;
        }
        let own_will_not_resolve = !eligible || resolved.is_some_and(|own| own.absent);
        match album {
            Some(album) if !album.absent => {
                if song.disc_number == 0 && own_will_not_resolve {
                    song.image = album.clone();
                }
            }
            _ if song.disc_number > 0 => {}
            Some(album) if album.absent && own_will_not_resolve => song.image.absent = true,
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> LibraryOptions {
        LibraryOptions::default()
    }

    #[test]
    fn sort_orders_are_built_as_navidrome_builds_them() {
        let d = defaults();
        // the ORDER BY clauses Navidrome 0.64.2 logs for the Subsonic lists
        assert_eq!(build_sort_order(Table::Album, "name", "", &d), "order_album_name asc, order_album_artist_name asc");
        assert_eq!(build_sort_order(Table::Album, "artist", "", &d), "compilation asc, order_album_artist_name asc, order_album_name asc");
        assert_eq!(build_sort_order(Table::Album, "recently_added", "desc", &d), "album.created_at desc, album.id desc");
        assert_eq!(build_sort_order(Table::Album, "starred_at", "desc", &d), "starred desc, starred_at desc");
        assert_eq!(build_sort_order(Table::Album, "playCount", "desc", &d), "play_count desc");
        assert_eq!(build_sort_order(Table::Album, "playDate", "desc", &d), "play_date desc");
        assert_eq!(build_sort_order(Table::Album, "rating", "desc", &d), "rating desc");
        assert_eq!(
            build_sort_order(Table::Album, "max_year", "", &d),
            "coalesce(nullif(original_date,''), cast(max_year as text)) asc, release_date asc, album.name asc"
        );
        assert_eq!(
            build_sort_order(Table::Album, "max_year", "desc", &d),
            "coalesce(nullif(original_date,''), cast(max_year as text)) desc, release_date desc, album.name desc"
        );
        assert_eq!(
            build_sort_order(Table::MediaFile, "album", "", &d),
            "order_album_name asc, album_id asc, disc_number asc, track_number asc, order_artist_name asc, media_file.title asc"
        );
        assert_eq!(build_sort_order(Table::MediaFile, "title", "", &d), "order_title asc");
        assert_eq!(build_sort_order(Table::MediaFile, "starred_at", "desc", &d), "starred desc, starred_at desc");
        // a mapping's own direction is kept, and turned around for a descending list
        assert_eq!(build_sort_order(Table::MediaFile, "id desc, title", "", &d), "id desc, order_title asc");
        assert_eq!(build_sort_order(Table::MediaFile, "id desc, title", "DESC", &d), "id asc, order_title desc");
    }

    #[test]
    fn sort_tags_and_natural_sorting_change_the_orders() {
        let by_mod_time = LibraryOptions { recently_added_by_mod_time: true, ..defaults() };
        assert_eq!(build_sort_order(Table::Album, "recently_added", "desc", &by_mod_time), "album.updated_at desc, album.id desc");
        assert_eq!(build_sort_order(Table::MediaFile, "recently_added", "", &by_mod_time), "media_file.updated_at asc, media_file.id asc");

        let sort_tags = LibraryOptions { prefer_sort_tags: true, ..defaults() };
        assert_eq!(
            build_sort_order(Table::Album, "name", "", &sort_tags),
            "(coalesce(nullif(album.sort_album_name,''),album.order_album_name) collate nocase) asc, \
             (coalesce(nullif(album.sort_album_artist_name,''),album.order_album_artist_name) collate nocase) asc"
        );
        assert_eq!(
            build_sort_order(Table::MediaFile, "title", "desc", &sort_tags),
            "(coalesce(nullif(media_file.sort_title,''),media_file.order_title) collate nocase) desc"
        );

        let natural = LibraryOptions { enable_natural_sorting: true, ..defaults() };
        assert_eq!(
            build_sort_order(Table::Album, "name", "", &natural),
            "(album.order_album_name collate NATSORT) asc, (album.order_album_artist_name collate NATSORT) asc"
        );
        // the mapping is lowercased before its order_* columns are replaced: a collation it named itself is lowercase
        // (SQLite does not mind)
        assert_eq!(
            build_sort_order(Table::Album, "max_year", "", &natural),
            "coalesce(nullif(original_date,''), cast(max_year as text)) asc, release_date asc, (album.name collate natsort) asc"
        );
        assert_eq!(
            build_sort_order(Table::MediaFile, "album", "", &natural),
            "(media_file.order_album_name collate NATSORT) asc, album_id asc, disc_number asc, track_number asc, \
             (media_file.order_artist_name collate NATSORT) asc, (media_file.title collate natsort) asc"
        );
    }

    #[test]
    fn names_change_case_as_gos_helpers_change_them() {
        for (camel, snake) in [("playDate", "play_date"), ("playCount", "play_count"), ("name", "name"), ("starredAt", "starred_at"), ("maxYear", "max_year")] {
            assert_eq!(to_snake_case(camel), snake);
            assert_eq!(to_camel_case(snake), camel);
        }
        assert_eq!(to_snake_case("HTTPServer"), "http_server");
        assert_eq!(to_snake_case("album.created_at"), "album.created_at");
        assert_eq!(to_snake_case("SEEDEDRAND('album|00ff', CAST(album.id AS TEXT))"), "seededrand('album|00ff', cast(album.id as text))");
        assert_eq!(split_outside_brackets("a, f(b, c) desc,, d", ','), vec!["a", " f(b, c) desc", " d"]);
        assert_eq!(split_outside_brackets(" f(b, c)  desc", ' '), vec!["f(b, c)", "desc"]);
    }

    #[test]
    fn conditions_are_written_as_squirrel_writes_them() {
        let by_year = Cond::or(vec![
            Cond::and(vec![Cond::compare("min_year", ">=", Value::Integer(2015)), Cond::compare("min_year", "<=", Value::Integer(2020))]),
            Cond::and(vec![Cond::compare("max_year", ">=", Value::Integer(2015)), Cond::compare("max_year", "<=", Value::Integer(2020))]),
        ])
        .not_missing();
        assert_eq!(by_year.sql, "(missing = ? AND ((min_year >= ? AND min_year <= ?) OR (max_year >= ? AND max_year <= ?)))");
        assert_eq!(by_year.args.len(), 5);
        let viewer = Viewer { id: "u".into(), name: "u".into(), is_admin: false, libraries: vec![1], all_libraries: 1 };
        let mut args = Vec::new();
        let filter = Cond::and(vec![not_missing(), viewer.music_folders().unwrap()]);
        let list = ListOptions { filter: Some(filter), order_by: Some("order_album_name asc".into()), max: 3, offset: 3 };
        assert_eq!(
            tail(&list, viewer.library_filter("album"), &mut args),
            " WHERE (missing = ? AND library_id IN (?)) ORDER BY order_album_name asc LIMIT 3 OFFSET 3"
        );
        // a user without the library: Navidrome's subquery over user_library
        let outsider = Viewer { libraries: Vec::new(), ..viewer.clone() };
        assert!(outsider.music_folders().is_none());
        let mut args = Vec::new();
        let list = ListOptions { filter: Some(not_missing()), ..ListOptions::default() };
        assert_eq!(
            tail(&list, outsider.library_filter("album"), &mut args),
            " WHERE missing = ? AND album.library_id IN (SELECT ul.library_id FROM user_library ul WHERE ul.user_id = ?)"
        );
        assert_eq!(args.len(), 2);
        // an admin sees every library, granted or not
        assert!(Viewer { is_admin: true, ..outsider }.library_filter("album").is_none());
    }

    #[test]
    fn stored_json_is_read_as_navidrome_reads_it() {
        let tags = parse_tags(r#"{"genre":[{"id":"a","value":"Rock"},{"id":"b","value":"Pop"}],"mood":[{"id":"c","value":"Calm"}]}"#).unwrap();
        assert_eq!(tags.values("genre"), ["Rock", "Pop"]);
        assert_eq!(tags.first("mood"), Some("Calm"));
        assert!(tags.values("isrc").is_empty());
        assert_eq!(parse_tags("{}").unwrap(), Tags::default());
        assert!(parse_tags("[1]").is_err());
        assert!(parse_tags("not json").is_err());

        let participants = parse_participants(
            r#"{"albumartist":[{"id":"1","name":"A"}],"performer":[{"id":"2","name":"B","subRole":"Guitar"}],"artist":[{"id":"1","name":"A"}]}"#,
        )
        .unwrap();
        assert_eq!(participants.role("artist"), [Participant { id: "1".into(), name: "A".into(), sub_role: String::new() }]);
        assert_eq!(participants.role("performer")[0].sub_role, "Guitar");
        assert!(participants.role("composer").is_empty());
        assert!(parse_participants(r#"{"singer":[]}"#).is_err(), "a role Navidrome does not know fails its decoding");
        assert_eq!(parse_participants("{}").unwrap(), Participants::default());

        assert_eq!(parse_discs(r#"{"2":"Night","1":"Day"}"#).unwrap().len(), 2);
        assert!(parse_discs(r#"{"one":"Day"}"#).is_err());
        assert!(parse_discs("{}").unwrap().is_empty());
    }
}
