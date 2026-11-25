//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.
//!
//! Albums and songs as the Subsonic API shows them: Navidrome's `server/subsonic/helpers.go` (`buildAlbumID3`,
//! `childFromMediaFile`) and the JSON its response structs make (`responses/responses.go`): the same fields in the
//! same order, left out when Go's `omitempty` leaves them out.

use crate::config::LibraryOptions;

use super::catalog::{Artist, Playlist, Rules};
use super::json::Json;
use super::query::{Album, ItemImage, Participant, Song, Tags};

/// What an answer depends on besides the rows: Navidrome's settings and the player the request came from.
pub struct Context<'a> {
    pub options: &'a LibraryOptions,
    /// The player's client name (`c`).
    pub client: &'a str,
    /// The player's `ReportRealPath`: songs carry the file's path, not one made up from the tags.
    pub report_real_path: bool,
    /// The public links of this request (`artistImageUrl`); none: an artist with a picture is Navidrome's.
    pub image_links: Option<&'a super::links::ImageLinks>,
}

/// Go's `int32(x)` of an `int`: the low 32 bits.
fn int32(value: i64) -> i64 {
    value as i32 as i64
}

/// Go's `int32(x)` of a `float32` the driver filled from a REAL column: towards zero.
fn int32_of_float32(value: f64) -> i64 {
    (value as f32) as i32 as i64
}

/// `isClientInList`: the client is one of a comma-separated list's names.
pub fn is_client_in_list(list: &str, client: &str) -> bool {
    !list.is_empty() && !client.is_empty() && list.split(',').any(|name| name.trim() == client)
}

/// `appendSuffix`: a subtitle or version after a name, in brackets unless it brings its own.
fn append_suffix(base: &str, suffix: &str) -> String {
    let suffix = suffix.trim();
    let bytes = suffix.as_bytes();
    let closes = |open: u8| match open {
        b'(' => Some(b')'),
        b'[' => Some(b']'),
        b'{' => Some(b'}'),
        b'<' => Some(b'>'),
        _ => None,
    };
    if bytes.len() >= 2 && closes(bytes[0]) == Some(bytes[bytes.len() - 1]) { format!("{base} {suffix}") } else { format!("{base} ({suffix})") }
}

/// `Album.FullName`.
pub fn album_full_name(album: &Album, options: &LibraryOptions) -> String {
    match album.tags.first("albumversion") {
        Some(version) if options.append_album_version => append_suffix(&album.name, version),
        _ => album.name.clone(),
    }
}

/// `MediaFile.FullTitle`.
pub fn song_full_title(song: &Song, options: &LibraryOptions) -> String {
    match song.tags.first("subtitle") {
        Some(subtitle) if options.append_subtitle => append_suffix(&song.title, subtitle),
        _ => song.title.clone(),
    }
}

/// `MediaFile.FullAlbumName`.
fn song_full_album_name(song: &Song, options: &LibraryOptions) -> String {
    match song.tags.first("albumversion") {
        Some(version) if options.append_album_version => append_suffix(&song.album, version),
        _ => song.album.clone(),
    }
}

/// `sortName`: the sort tag first when those are preferred, else the name made for ordering.
fn sort_name<'a>(sort: &'a str, order: &'a str, options: &LibraryOptions) -> &'a str {
    if options.prefer_sort_tags && !sort.is_empty() { sort } else { order }
}

/// `ArtworkID.String` with `coverArtOrEmpty`: `al-<id>_<hash>`, without the hash while the picture is unresolved,
/// nothing when the item is known to have none.
fn cover_art(prefix: &str, id: &str, hash: &str, absent: bool) -> String {
    if absent || id.is_empty() {
        return String::new();
    }
    if hash.is_empty() { format!("{prefix}-{id}") } else { format!("{prefix}-{id}_{hash}") }
}

/// `Album.CoverArtID`.
pub fn album_cover_art(album: &Album) -> String {
    cover_art("al", &album.id, &album.image.hash, album.image.absent)
}

/// `MediaFile.CoverArtID`: the song's own picture, else its disc's, else its album's.
pub fn song_cover_art(song: &Song, options: &LibraryOptions) -> String {
    let ItemImage { hash, absent } = &song.image;
    if song.has_cover_art && options.enable_media_file_cover_art {
        return cover_art("mf", &song.id, hash, *absent);
    }
    if song.disc_number > 0 {
        return cover_art("dc", &format!("{}:{}", song.album_id, song.disc_number), hash, *absent);
    }
    cover_art("al", &song.album_id, &song.album_image.hash, *absent)
}

/// `albumCreatedAt` and `mediaFileCreatedAt`: the first of the three times that is set.
fn first_time<'a>(first: &'a Option<String>, second: &'a Option<String>, last: &'a Option<String>, options: &LibraryOptions) -> Option<&'a str> {
    let (first, second) = if options.recently_added_by_mod_time { (second, first) } else { (first, second) };
    first.as_deref().or(second.as_deref()).or(last.as_deref())
}

/// `mapExplicitStatus`.
fn explicit_status(stored: &str) -> &'static str {
    match stored {
        "c" => "clean",
        "e" => "explicit",
        _ => "",
    }
}

/// Go's `number.ParseInt[int32]`: 0 for anything that is not a number.
fn parse_int32(text: &str) -> i64 {
    int32(text.parse::<i64>().unwrap_or(0))
}

/// `toItemDate`: `2015-03-01`, `2015-03` or `2015`.
fn item_date(j: &mut Json, name: &str, date: &str) {
    j.object(name, |j| {
        if date.is_empty() {
            return;
        }
        let parts: Vec<&str> = date.split('-').collect();
        j.int_ne("year", parse_int32(parts[0]));
        if parts.len() > 1 {
            j.int_ne("month", parse_int32(parts[1]));
        }
        if parts.len() > 2 {
            j.int_ne("day", parse_int32(parts[2]));
        }
    });
}

fn genres(j: &mut Json, tags: &Tags) {
    j.array("genres", tags.values("genre"), |j, name| {
        j.begin_object();
        j.string("name", name);
        j.end_object();
    });
}

fn strings(j: &mut Json, name: &str, values: &[String]) {
    j.array(name, values, |j, value| j.string_value(value));
}

/// `artistRefs`.
fn artist_refs(j: &mut Json, name: &str, artists: &[Participant]) {
    j.array(name, artists, |j, artist| {
        j.begin_object();
        j.string("id", &artist.id);
        j.string("name", &artist.name);
        j.end_object();
    });
}

/// `buildDiscSubtitles`: the discs with their titles, none when the album's only disc has no title.
fn disc_titles(j: &mut Json, album: &Album) {
    let mut discs: Vec<&(i64, String)> = album.discs.iter().collect();
    if discs.len() == 1 && discs[0].1.is_empty() {
        discs.clear();
    }
    discs.sort_by_key(|(number, _)| int32(*number));
    j.array("discTitles", discs, |j, (number, title)| {
        j.begin_object();
        j.int("disc", int32(*number));
        j.string("title", title);
        j.string_ne("coverArt", &format!("dc-{}:{}", album.id, number));
        j.end_object();
    });
}

/// `buildAlbumID3`'s members (`responses.AlbumID3`), inside an object the caller opened.
pub fn album_members(j: &mut Json, album: &Album, context: &Context) {
    let options = context.options;
    j.string("id", &album.id);
    j.string("name", &album_full_name(album, options));
    j.string_ne("artist", &album.album_artist);
    j.string_ne("artistId", &album.album_artist_id);
    j.string_ne("coverArt", &album_cover_art(album));
    j.int("songCount", int32(album.song_count));
    j.int("duration", int32_of_float32(album.duration));
    j.int_ne("playCount", album.annotations.play_count);
    j.time("created", first_time(&album.created_at, &album.updated_at, &album.imported_at, options));
    if album.annotations.starred {
        j.time_some("starred", album.annotations.starred_at.as_deref());
    }
    j.int_ne("year", int32(if album.max_original_year != 0 { album.max_original_year } else { album.max_year }));
    j.string_ne("genre", &album.genre);
    // buildOSAlbumID3: not for the clients named in Subsonic.LegacyClients, which Navidrome finds by substring here
    if options.legacy_clients.contains(context.client) {
        return;
    }
    if album.annotations.play_count > 0 {
        j.time_some("played", album.annotations.play_date.as_deref());
    }
    j.int("userRating", int32(album.annotations.rating));
    if options.enable_average_rating {
        j.float_ne("averageRating", album.annotations.average_rating);
    }
    genres(j, &album.tags);
    j.string("musicBrainzId", &album.mbz_album_id);
    j.boolean("isCompilation", album.compilation);
    j.string("sortName", sort_name(&album.sort_album_name, &album.order_album_name, options));
    disc_titles(j, album);
    item_date(j, "originalReleaseDate", &album.original_date);
    item_date(j, "releaseDate", &album.release_date);
    strings(j, "releaseTypes", album.tags.values("releasetype"));
    j.array("recordLabels", album.tags.values("recordlabel"), |j, label| {
        j.begin_object();
        j.string("name", label);
        j.end_object();
    });
    strings(j, "moods", album.tags.values("mood"));
    artist_refs(j, "artists", album.participants.role("albumartist"));
    j.string("displayArtist", &album.album_artist);
    j.string("explicitStatus", explicit_status(&album.explicit_status));
    j.string("version", album.tags.first("albumversion").unwrap_or(""));
}

/// One album as a value.
pub fn album(j: &mut Json, album: &Album, context: &Context) {
    j.begin_object();
    album_members(j, album, context);
    j.end_object();
}

/// `fakePath`: a path made up from the tags, for clients that show one.
fn fake_path(song: &Song, options: &LibraryOptions) -> String {
    let no_slashes = |text: &str| text.replace('/', "_");
    let mut path = format!("{}/{}/", no_slashes(&song.album_artist), no_slashes(&song_full_album_name(song, options)));
    if song.disc_number != 0 {
        path.push_str(&format!("{:02}-", song.disc_number));
    }
    if song.track_number != 0 {
        path.push_str(&format!("{:02} - ", song.track_number));
    }
    path.push_str(&format!("{}.{}", no_slashes(&song_full_title(song, options)), song.suffix));
    path
}

/// Go's `filepath.Join(libraryPath, path)` where paths are Unix paths: joined with a slash and cleaned
/// (`path.Clean`: no doubled slashes, no `.`, `..` resolved). The server's image runs on Linux; on Windows Go joins
/// with its own rules (volumes, backslashes), which this does not do (`REAL_PATHS`).
pub fn unix_join(base: &str, rest: &str) -> String {
    let joined = match (base.is_empty(), rest.is_empty()) {
        (true, true) => return String::new(),
        (true, false) => rest.to_string(),
        (false, true) => base.to_string(),
        (false, false) => format!("{base}/{rest}"),
    };
    let rooted = joined.starts_with('/');
    let mut kept: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => match kept.last() {
                Some(&last) if last != ".." => {
                    kept.pop();
                }
                _ if rooted => {}
                _ => kept.push(".."),
            },
            part => kept.push(part),
        }
    }
    let cleaned = kept.join("/");
    match (rooted, cleaned.is_empty()) {
        (true, _) => format!("/{cleaned}"),
        (false, true) => ".".to_string(),
        (false, false) => cleaned,
    }
}

/// Whether real paths (a player's `ReportRealPath`) are made here: where Go's `filepath.Join` is `unix_join`.
pub const REAL_PATHS: bool = cfg!(unix);

/// A song's content type by its suffix: Go's `mime.TypeByExtension` with the types Navidrome registers
/// (`resources/mime_types.yaml`) over Go's own. None for a suffix in neither: Go then asks the operating system's
/// tables, which this server does not read, so such a song's answer is left to Navidrome.
pub fn content_type(suffix: &str) -> Option<&'static str> {
    // Go looks the extension up as written, then lowercased
    Some(match suffix.to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "aac" => "audio/aac",
        "alac" | "m4a" | "m4b" => "audio/mp4",
        "flac" => "audio/flac",
        "wav" => "audio/x-wav",
        "wma" => "audio/x-ms-wma",
        "ape" => "audio/x-monkeys-audio",
        "mpc" => "audio/x-musepack",
        "shn" => "audio/x-shn",
        "aif" | "aiff" => "audio/x-aiff",
        "m3u" => "audio/x-mpegurl",
        "pls" => "audio/x-scpls",
        "dsf" => "audio/x-dsf",
        "wv" | "wvp" => "audio/x-wavpack",
        "tak" => "audio/tak",
        "mka" => "audio/x-matroska",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "png" => "image/png",
        "bmp" => "image/bmp",
        "jxl" => "image/jxl",
        "heic" => "image/heic",
        "heif" => "image/heif",
        _ => return None,
    })
}

/// Whether every song's answer can be made here: see `content_type`.
pub fn songs_are_answerable(songs: &[Song]) -> bool {
    songs.iter().all(|song| content_type(&song.suffix).is_some())
}

/// `childFromMediaFile` (`responses.Child`), as one value.
pub fn song(j: &mut Json, song: &Song, context: &Context) {
    j.begin_object();
    song_members(j, song, context);
    j.end_object();
}

/// `childFromMediaFile`'s members, inside an object the caller opened.
pub fn song_members(j: &mut Json, song: &Song, context: &Context) {
    let options = context.options;
    j.string("id", &song.id);
    if is_client_in_list(&options.minimal_clients, context.client) {
        // Subsonic.MinimalClients: the id and the title, nothing else
        j.boolean("isDir", false);
        j.string("title", &song_full_title(song, options));
        return;
    }
    j.string_ne("parent", &song.album_id);
    j.boolean("isDir", false);
    j.string("title", &song_full_title(song, options));
    j.string_ne("album", &song_full_album_name(song, options));
    j.string_ne("artist", &song.artist);
    j.int_ne("track", int32(song.track_number));
    j.int_ne("year", int32(song.year));
    j.string_ne("genre", &song.genre);
    j.string_ne("coverArt", &song_cover_art(song, options));
    j.int_ne("size", song.size);
    j.string_ne("contentType", content_type(&song.suffix).unwrap_or(""));
    j.string_ne("suffix", &song.suffix);
    if song.annotations.starred {
        j.time_some("starred", song.annotations.starred_at.as_deref());
    }
    j.int_ne("duration", int32_of_float32(song.duration));
    j.int_ne("bitRate", int32(song.bit_rate));
    let path = if context.report_real_path { unix_join(&song.library_path, &song.path) } else { fake_path(song, options) };
    j.string_ne("path", &path);
    j.int_ne("playCount", song.annotations.play_count);
    j.int_ne("discNumber", int32(song.disc_number));
    // a pointer in Go, never nil: the zero time is written too
    j.time("created", first_time(&song.created_at, &song.updated_at, &song.birth_time, options));
    j.string_ne("albumId", &song.album_id);
    j.string_ne("artistId", &song.artist_id);
    j.string("type", "music");
    j.int_ne("userRating", int32(song.annotations.rating));
    if options.enable_average_rating {
        j.float_ne("averageRating", song.annotations.average_rating);
    }
    j.int_ne("bookmarkPosition", song.bookmark_position);
    // osChildFromMediaFile: not for the clients listed in Subsonic.LegacyClients
    if is_client_in_list(&options.legacy_clients, context.client) {
        return;
    }
    if song.annotations.play_count > 0 {
        j.time_some("played", song.annotations.play_date.as_deref());
    }
    j.int("bpm", int32(song.bpm.unwrap_or(0)));
    j.string("comment", &song.comment);
    j.string("sortName", sort_name(&song.sort_title, &song.order_title, options));
    j.string("mediaType", "song");
    j.string("musicBrainzId", &song.mbz_recording_id);
    strings(j, "isrc", song.tags.values("isrc"));
    genres(j, &song.tags);
    j.object("replayGain", |j| {
        j.float_some("trackGain", song.rg_track_gain);
        j.float_some("albumGain", song.rg_album_gain);
        j.float_some("trackPeak", song.rg_track_peak);
        j.float_some("albumPeak", song.rg_album_peak);
    });
    j.int("channelCount", int32(song.channels));
    j.int("samplingRate", int32(song.sample_rate));
    j.int("bitDepth", int32(song.bit_depth.unwrap_or(0)));
    strings(j, "moods", song.tags.values("mood"));
    artist_refs(j, "artists", song.participants.role("artist"));
    j.string("displayArtist", &song.artist);
    artist_refs(j, "albumArtists", song.participants.role("albumartist"));
    j.string("displayAlbumArtist", &song.album_artist);
    // Go walks its map of roles in no order; here the roles come sorted by name
    let others = song.participants.0.iter().filter(|(role, _)| role != "artist" && role != "albumartist");
    let contributors = others.flat_map(|(role, artists)| artists.iter().map(move |artist| (role, artist)));
    j.array("contributors", contributors, |j, (role, artist)| {
        j.begin_object();
        j.string("role", role);
        j.string_ne("subRole", &artist.sub_role);
        j.object("artist", |j| {
            j.string("id", &artist.id);
            j.string("name", &artist.name);
        });
        j.end_object();
    });
    let composer = |p: &Participant| if p.sub_role.is_empty() { p.name.clone() } else { format!("{} ({})", p.name, p.sub_role) };
    let composers: Vec<String> = song.participants.role("composer").iter().map(composer).collect();
    j.string("displayComposer", &composers.join(" \u{2022} "));
    j.string("explicitStatus", explicit_status(&song.explicit_status));
    strings(j, "groupings", song.tags.values("grouping"));
    let work_ids = song.tags.values("musicbrainz_workid");
    j.array("works", song.tags.values("work").iter().enumerate(), |j, (i, name)| {
        j.begin_object();
        j.string("name", name);
        j.string_ne("musicBrainzId", work_ids.get(i).map(String::as_str).unwrap_or(""));
        j.end_object();
    });
    let (numbers, counts) = (song.tags.values("movement"), song.tags.values("movementtotal"));
    j.array("movements", song.tags.values("movementname").iter().enumerate(), |j, (i, name)| {
        j.begin_object();
        j.string("name", name);
        j.int_ne("number", numbers.get(i).map(|n| parse_int32(n)).unwrap_or(0));
        j.int_ne("count", counts.get(i).map(|n| parse_int32(n)).unwrap_or(0));
        j.end_object();
    });
}

/// `toArtistID3` (`responses.ArtistID3`). An artist with a picture, or whose picture is not resolved yet, carries
/// `artistImageUrl`, a link signed with Navidrome's public secret (links.rs); without one, its answer is Navidrome's
/// (`artist_is_answerable`).
pub fn artist(j: &mut Json, artist: &Artist, context: &Context) {
    let options = context.options;
    j.begin_object();
    j.string("id", &artist.id);
    j.string("name", &artist.name);
    j.string_ne("coverArt", &cover_art("ar", &artist.id, &artist.image.hash, artist.image.absent));
    // getArtistAlbumCount: as album artist, or with Subsonic.ArtistParticipations as artist too
    let role = if options.artist_participations { "maincredit" } else { "albumartist" };
    j.int("albumCount", int32(artist.album_count(role)));
    if artist.annotations.starred {
        j.time_some("starred", artist.annotations.starred_at.as_deref());
    }
    j.int_ne("userRating", int32(artist.annotations.rating));
    if options.enable_average_rating {
        j.float_ne("averageRating", artist.annotations.average_rating);
    }
    // a link to the picture, signed with Navidrome's public secret, for any artist not known to have none
    if let (false, Some(links)) = (artist.image.absent, context.image_links) {
        j.string("artistImageUrl", &links.artist(&artist.id, &artist.image.hash));
    }
    // toOSArtistID3: not for the clients named in Subsonic.LegacyClients, found by substring as for albums
    if !options.legacy_clients.contains(context.client) {
        j.string("musicBrainzId", &artist.mbz_artist_id);
        j.string("sortName", sort_name(&artist.sort_artist_name, &artist.order_artist_name, options));
        // Go lists the roles from a map, in no order; here they come sorted
        j.array("roles", artist.album_counts.iter(), |j, (role, _)| j.string_value(role));
    }
    j.end_object();
}

/// Whether an artist's answer can be made here: when it is known to have no picture, or its link can be made.
pub fn artist_is_answerable(artist: &Artist, context: &Context) -> bool {
    artist.image.absent || context.image_links.is_some()
}

/// `buildPlaylist` (`responses.Playlist`)'s members: `song_count` and `duration` are the stored ones for a list of
/// playlists, and counted from the songs for a playlist shown with them.
pub fn playlist_members(j: &mut Json, playlist: &Playlist, song_count: i64, duration: f64, viewer_id: &str, context: &Context) {
    let options = context.options;
    let minimal = is_client_in_list(&options.minimal_clients, context.client);
    j.string("id", &playlist.id);
    j.string("name", &playlist.name);
    if !minimal {
        j.string_ne("comment", &playlist.comment);
    }
    j.int("songCount", int32(song_count));
    j.int("duration", int32_of_float32(duration));
    if minimal {
        j.time("created", playlist.created_at.as_deref());
        j.time("changed", playlist.updated_at.as_deref());
        return;
    }
    j.boolean_ne("public", playlist.public);
    j.string_ne("owner", &playlist.owner_name);
    j.time("created", playlist.created_at.as_deref());
    j.time("changed", playlist.updated_at.as_deref());
    j.string_ne("coverArt", &cover_art("pl", &playlist.id, &playlist.image.hash, playlist.image.absent));
    // buildOSPlaylist
    if is_client_in_list(&options.legacy_clients, context.client) {
        return;
    }
    if playlist.rules() == Rules::Plain {
        // someone else's, or one Navidrome keeps in step with a file
        j.boolean("readonly", playlist.owner_id != viewer_id || playlist.sync);
    } else {
        j.boolean("readonly", true);
        j.time_some("validUntil", playlist.valid_until(options.smart_playlist_refresh_delay).as_deref());
    }
}

/// A playlist's length as Navidrome adds it up for a playlist shown with its songs (`refreshStats`): in float32.
pub fn songs_duration(songs: &[Song]) -> f64 {
    songs.iter().fold(0f32, |sum, song| sum + song.duration as f32) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::query::{Annotations, Participants};

    fn options() -> LibraryOptions {
        LibraryOptions::default()
    }

    fn context(options: &LibraryOptions) -> Context<'_> {
        Context { options, client: "sonus", report_real_path: false, image_links: None }
    }

    fn written(write: impl FnOnce(&mut Json)) -> String {
        let mut j = Json::new();
        write(&mut j);
        j.finish()
    }

    fn one(id: &str, name: &str) -> Vec<Participant> {
        vec![Participant { id: id.into(), name: name.into(), sub_role: String::new() }]
    }

    fn a_song() -> Song {
        Song {
            id: "1qsif0m3qMNj6JVAix0aY9".into(),
            library_path: "/music".into(),
            path: "Aurora Lane/Northern Lights/01 - First Light.flac".into(),
            title: "First Light".into(),
            album: "Northern Lights".into(),
            artist_id: "1MNu0aqmjGxOZOiezuZPxB".into(),
            artist: "Aurora Lane".into(),
            album_artist: "Aurora Lane".into(),
            album_id: "7sUNA4P7FqEWNSryFglgb4".into(),
            track_number: 1,
            disc_number: 1,
            year: 2015,
            size: 265795,
            suffix: "flac".into(),
            duration: 3.0,
            bit_rate: 706,
            sample_rate: 44100,
            bit_depth: Some(16),
            channels: 1,
            genre: "Electronic".into(),
            order_title: "first light".into(),
            bpm: Some(97),
            mbz_recording_id: "0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f01".into(),
            rg_album_gain: Some(-7.1),
            rg_album_peak: Some(0.977),
            rg_track_gain: Some(-7.2),
            rg_track_peak: Some(0.91),
            tags: Tags(vec![("genre".into(), vec!["Electronic".into(), "Ambient".into()])]),
            participants: Participants(vec![
                ("albumartist".into(), one("1MNu0aqmjGxOZOiezuZPxB", "Aurora Lane")),
                ("artist".into(), one("1MNu0aqmjGxOZOiezuZPxB", "Aurora Lane")),
            ]),
            created_at: Some("2026-11-24T23:42:33.5996899+01:00".into()),
            updated_at: Some("2026-01-01T13:00:00+01:00".into()),
            annotations: Annotations {
                play_count: 1,
                play_date: Some("2026-01-04T22:15:00+01:00".into()),
                starred: true,
                starred_at: Some("2026-11-24T23:42:33.8835827+01:00".into()),
                ..Annotations::default()
            },
            ..Song::default()
        }
    }

    #[test]
    fn a_song_is_navidromes_bytes() {
        // Navidrome 0.64.2-sonus.10's getSong answer for the fixture library's "First Light", from "song": on
        let expected = r#"{"id":"1qsif0m3qMNj6JVAix0aY9","parent":"7sUNA4P7FqEWNSryFglgb4","isDir":false,"title":"First Light","album":"Northern Lights","artist":"Aurora Lane","track":1,"year":2015,"genre":"Electronic","coverArt":"dc-7sUNA4P7FqEWNSryFglgb4:1","size":265795,"contentType":"audio/flac","suffix":"flac","starred":"2026-11-24T23:42:33.8835827+01:00","duration":3,"bitRate":706,"path":"Aurora Lane/Northern Lights/01-01 - First Light.flac","playCount":1,"discNumber":1,"created":"2026-11-24T23:42:33.5996899+01:00","albumId":"7sUNA4P7FqEWNSryFglgb4","artistId":"1MNu0aqmjGxOZOiezuZPxB","type":"music","played":"2026-01-04T22:15:00+01:00","bpm":97,"comment":"","sortName":"first light","mediaType":"song","musicBrainzId":"0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f01","isrc":[],"genres":[{"name":"Electronic"},{"name":"Ambient"}],"replayGain":{"trackGain":-7.2,"albumGain":-7.1,"trackPeak":0.91,"albumPeak":0.977},"channelCount":1,"samplingRate":44100,"bitDepth":16,"moods":[],"artists":[{"id":"1MNu0aqmjGxOZOiezuZPxB","name":"Aurora Lane"}],"displayArtist":"Aurora Lane","albumArtists":[{"id":"1MNu0aqmjGxOZOiezuZPxB","name":"Aurora Lane"}],"displayAlbumArtist":"Aurora Lane","contributors":[],"displayComposer":"","explicitStatus":"","groupings":[],"works":[],"movements":[]}"#;
        let options = options();
        assert_eq!(written(|j| song(j, &a_song(), &context(&options))), expected);
    }

    #[test]
    fn an_album_is_navidromes_bytes() {
        // the same server's getAlbumList2 entry for "Twin Discs"
        let expected = r#"{"id":"1EBy5YqDoVDtVWGZVSvlnd","name":"Twin Discs","artist":"Kenji Mori","artistId":"6DKgjA3l1lUwZU5UWmtlID","coverArt":"al-1EBy5YqDoVDtVWGZVSvlnd_33401af5b95c979a","songCount":4,"duration":13,"created":"2026-11-24T23:42:32.1058383+01:00","year":2020,"genre":"Jazz","userRating":5,"averageRating":5,"genres":[{"name":"Jazz"},{"name":"Fusion"}],"musicBrainzId":"","isCompilation":false,"sortName":"twin discs","discTitles":[{"disc":1,"title":"Day","coverArt":"dc-1EBy5YqDoVDtVWGZVSvlnd:1"},{"disc":2,"title":"Night","coverArt":"dc-1EBy5YqDoVDtVWGZVSvlnd:2"}],"originalReleaseDate":{},"releaseDate":{"year":2020,"month":11,"day":1},"releaseTypes":[],"recordLabels":[],"moods":[],"artists":[{"id":"6DKgjA3l1lUwZU5UWmtlID","name":"Kenji Mori"}],"displayArtist":"Kenji Mori","explicitStatus":"","version":""}"#;
        let twin = Album {
            id: "1EBy5YqDoVDtVWGZVSvlnd".into(),
            name: "Twin Discs".into(),
            album_artist: "Kenji Mori".into(),
            album_artist_id: "6DKgjA3l1lUwZU5UWmtlID".into(),
            max_year: 2020,
            release_date: "2020-11-01".into(),
            song_count: 4,
            duration: 13.569999694824219,
            discs: vec![(2, "Night".into()), (1, "Day".into())],
            order_album_name: "twin discs".into(),
            genre: "Jazz".into(),
            tags: Tags(vec![("genre".into(), vec!["Jazz".into(), "Fusion".into()])]),
            participants: Participants(vec![("albumartist".into(), one("6DKgjA3l1lUwZU5UWmtlID", "Kenji Mori"))]),
            created_at: Some("2026-11-24T23:42:32.1058383+01:00".into()),
            annotations: Annotations { rating: 5, average_rating: 5.0, ..Annotations::default() },
            image: ItemImage { hash: "33401af5b95c979a".into(), absent: false },
            ..Album::default()
        };
        let options = options();
        assert_eq!(written(|j| album(j, &twin, &context(&options))), expected);
    }

    #[test]
    fn settings_change_the_answers() {
        let mut s = a_song();
        s.tags.0.push(("subtitle".into(), vec!["Live".into()]));
        s.tags.0.push(("albumversion".into(), vec!["[Deluxe]".into()]));
        s.sort_title = "Light, First".into();
        s.annotations.average_rating = 4.5;
        let d = options();
        let text = written(|j| song(j, &s, &context(&d)));
        assert!(text.contains(r#""title":"First Light (Live)""#), "{text}");
        assert!(text.contains(r#""album":"Northern Lights [Deluxe]""#));
        assert!(text.contains(r#""path":"Aurora Lane/Northern Lights [Deluxe]/01-01 - First Light (Live).flac""#));
        assert!(text.contains(r#""sortName":"first light""#));
        assert!(text.contains(r#""averageRating":4.5"#));

        let plain = LibraryOptions { append_subtitle: false, append_album_version: false, enable_average_rating: false, prefer_sort_tags: true, ..options() };
        let text = written(|j| song(j, &s, &context(&plain)));
        assert!(text.contains(r#""title":"First Light","album":"Northern Lights","#), "{text}");
        assert!(text.contains(r#""sortName":"Light, First""#));
        assert!(!text.contains("averageRating"));

        // RecentlyAddedByModTime: "created" is the file's change time
        let by_mod_time = LibraryOptions { recently_added_by_mod_time: true, ..options() };
        assert!(written(|j| song(j, &s, &context(&by_mod_time))).contains(r#""created":"2026-01-01T13:00:00+01:00""#));

        // the player's ReportRealPath
        let real = Context { options: &d, client: "sonus", report_real_path: true, image_links: None };
        assert!(written(|j| song(j, &s, &real)).contains(r#""path":"/music/Aurora Lane/Northern Lights/01 - First Light.flac""#));

        // Subsonic.LegacyClients and MinimalClients
        let legacy = Context { options: &d, client: "DSub", report_real_path: false, image_links: None };
        let text = written(|j| song(j, &s, &legacy));
        assert!(text.ends_with(r#""type":"music","averageRating":4.5}"#), "{text}");
        let minimal = Context { options: &d, client: "SubMusic", report_real_path: false, image_links: None };
        assert_eq!(written(|j| song(j, &s, &minimal)), r#"{"id":"1qsif0m3qMNj6JVAix0aY9","isDir":false,"title":"First Light (Live)"}"#);
    }

    #[test]
    fn contributors_works_and_movements() {
        let mut s = a_song();
        s.participants.0.push((
            "composer".into(),
            vec![
                Participant { id: "c1".into(), name: "Ann".into(), sub_role: String::new() },
                Participant { id: "c2".into(), name: "Bo".into(), sub_role: "orchestration".into() },
            ],
        ));
        s.participants.0.push(("performer".into(), vec![Participant { id: "p1".into(), name: "Cy".into(), sub_role: "Guitar".into() }]));
        s.tags.0.push(("work".into(), vec!["Suite".into(), "Coda".into()]));
        s.tags.0.push(("musicbrainz_workid".into(), vec!["w-1".into()]));
        s.tags.0.push(("movementname".into(), vec!["Allegro".into()]));
        s.tags.0.push(("movement".into(), vec!["2".into()]));
        s.tags.0.push(("movementtotal".into(), vec!["x".into()]));
        s.tags.0.push(("isrc".into(), vec!["USRC17607839".into()]));
        s.explicit_status = "e".into();
        let d = options();
        let text = written(|j| song(j, &s, &context(&d)));
        assert!(
            text.contains(
                r#""contributors":[{"role":"composer","artist":{"id":"c1","name":"Ann"}},{"role":"composer","subRole":"orchestration","artist":{"id":"c2","name":"Bo"}},{"role":"performer","subRole":"Guitar","artist":{"id":"p1","name":"Cy"}}],"displayComposer":"Ann • Bo (orchestration)","explicitStatus":"explicit""#
            ),
            "{text}"
        );
        assert!(text.contains(r#""works":[{"name":"Suite","musicBrainzId":"w-1"},{"name":"Coda"}],"movements":[{"name":"Allegro","number":2}]"#), "{text}");
        assert!(text.contains(r#""isrc":["USRC17607839"]"#));
    }

    #[test]
    fn legacy_clients_are_found_as_navidrome_finds_them() {
        assert!(is_client_in_list("DSub", "DSub"));
        assert!(is_client_in_list("a, DSub ,b", "DSub"));
        assert!(!is_client_in_list("DSub", "DSu"));
        assert!(!is_client_in_list("", "DSub"));
        assert!(!is_client_in_list("DSub", ""));
        // albums: by substring (strings.Contains), so "DSu" is a legacy client there
        let d = options();
        let an_album = Album { id: "a".into(), name: "A".into(), ..Album::default() };
        for (client, with_extensions) in [("sonus", true), ("DSub", false), ("DSu", false), ("Sub", false), ("dsub", true)] {
            let text = written(|j| album(j, &an_album, &Context { options: &d, client, report_real_path: false, image_links: None }));
            assert_eq!(text.contains("userRating"), with_extensions, "{client}: {text}");
        }
    }

    #[test]
    fn cover_art_ids() {
        let d = options();
        let mut s = a_song();
        assert_eq!(song_cover_art(&s, &d), "dc-7sUNA4P7FqEWNSryFglgb4:1");
        s.image.hash = "9046b47ac73f2574".into();
        assert_eq!(song_cover_art(&s, &d), "dc-7sUNA4P7FqEWNSryFglgb4:1_9046b47ac73f2574");
        s.has_cover_art = true;
        assert_eq!(song_cover_art(&s, &d), "mf-1qsif0m3qMNj6JVAix0aY9_9046b47ac73f2574");
        s.image = ItemImage::default();
        assert_eq!(song_cover_art(&s, &d), "mf-1qsif0m3qMNj6JVAix0aY9");
        // EnableMediaFileCoverArt off: the disc's, and without a disc the album's with the album's hash
        let off = LibraryOptions { enable_media_file_cover_art: false, ..options() };
        assert_eq!(song_cover_art(&s, &off), "dc-7sUNA4P7FqEWNSryFglgb4:1");
        s.disc_number = 0;
        s.album_image.hash = "33401af5b95c979a".into();
        assert_eq!(song_cover_art(&s, &off), "al-7sUNA4P7FqEWNSryFglgb4_33401af5b95c979a");
        s.image.absent = true;
        assert_eq!(song_cover_art(&s, &off), "", "known to have none: left out");
        let mut al = Album { id: "x".into(), ..Album::default() };
        assert_eq!(album_cover_art(&al), "al-x");
        al.image = ItemImage { hash: "00ff00ff00ff00ff".into(), absent: false };
        assert_eq!(album_cover_art(&al), "al-x_00ff00ff00ff00ff");
        al.image = ItemImage { hash: String::new(), absent: true };
        assert_eq!(album_cover_art(&al), "");
    }

    #[test]
    fn paths_names_and_numbers() {
        assert_eq!(append_suffix("Song", "Live"), "Song (Live)");
        assert_eq!(append_suffix("Song", " (Live) "), "Song (Live)");
        assert_eq!(append_suffix("Song", "[Live]"), "Song [Live]");
        assert_eq!(append_suffix("Song", "(Live]"), "Song ((Live])");
        assert_eq!(append_suffix("Song", "<x>"), "Song <x>");
        assert_eq!(append_suffix("Song", "("), "Song (()");

        let d = options();
        let untagged = Song {
            title: "untagged".into(),
            album: "[Unknown Album]".into(),
            album_artist: "[Unknown Artist]".into(),
            suffix: "ogg".into(),
            ..Song::default()
        };
        assert_eq!(fake_path(&untagged, &d), "[Unknown Artist]/[Unknown Album]/untagged.ogg");
        let slashed = Song { title: "AC/DC".into(), album: "A/B".into(), album_artist: "X/Y".into(), track_number: 7, suffix: "mp3".into(), ..Song::default() };
        assert_eq!(fake_path(&slashed, &d), "X_Y/A_B/07 - AC_DC.mp3");

        assert_eq!(unix_join("/music", "a/b.flac"), "/music/a/b.flac");
        assert_eq!(unix_join("/music/", "/a//b.flac"), "/music/a/b.flac");
        assert_eq!(unix_join("/music", "../x/./y"), "/x/y");
        assert_eq!(unix_join("music", "../../x"), "../x");
        assert_eq!(unix_join("", "a"), "a");
        assert_eq!(unix_join("/", ".."), "/");
        assert_eq!(unix_join("", ""), "");

        assert_eq!(int32(2015), 2015);
        assert_eq!(int32(4_294_967_297), 1, "Go's int32() keeps the low 32 bits");
        assert_eq!(int32_of_float32(13.569999694824219), 13);
        assert_eq!(int32_of_float32(2.9999999999), 3, "a float32 first, as the model's field");
        assert_eq!(int32_of_float32(-1.5), -1);
        assert_eq!(parse_int32("03"), 3);
        assert_eq!(parse_int32("x"), 0);

        assert_eq!(content_type("flac"), Some("audio/flac"));
        assert_eq!(content_type("M4A"), Some("audio/mp4"));
        assert_eq!(content_type("wav"), Some("audio/x-wav"));
        assert_eq!(content_type("xyz"), None);
        assert_eq!(content_type(""), None);
    }

    #[test]
    fn dates_and_discs() {
        let dates = |date: &str| {
            written(|j| {
                j.begin_object();
                item_date(j, "d", date);
                j.end_object();
            })
        };
        assert_eq!(dates("2015-03-01"), r#"{"d":{"year":2015,"month":3,"day":1}}"#);
        assert_eq!(dates("2015-03"), r#"{"d":{"year":2015,"month":3}}"#);
        assert_eq!(dates("2015"), r#"{"d":{"year":2015}}"#);
        assert_eq!(dates(""), r#"{"d":{}}"#);
        assert_eq!(dates("soon"), r#"{"d":{}}"#);
        let discs = |discs: Vec<(i64, String)>| {
            let al = Album { id: "a".into(), discs, ..Album::default() };
            written(|j| {
                j.begin_object();
                disc_titles(j, &al);
                j.end_object();
            })
        };
        assert_eq!(discs(vec![(1, String::new())]), r#"{"discTitles":[]}"#, "one disc without a title: none");
        assert_eq!(discs(vec![]), r#"{"discTitles":[]}"#);
        assert_eq!(discs(vec![(1, "Only".into())]), r#"{"discTitles":[{"disc":1,"title":"Only","coverArt":"dc-a:1"}]}"#);
        assert_eq!(
            discs(vec![(2, String::new()), (1, String::new())]),
            r#"{"discTitles":[{"disc":1,"title":"","coverArt":"dc-a:1"},{"disc":2,"title":"","coverArt":"dc-a:2"}]}"#
        );
    }
}
