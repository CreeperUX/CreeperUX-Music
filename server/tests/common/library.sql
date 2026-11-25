-- The library's tables as the frozen Navidrome (0.64.2-sonus.10) makes them: the CREATE statements of a database the
-- fork made (tools/fixtures), unchanged, with its FTS5 tables and the triggers that fill them. For the tests of
-- server/src/library (tests/library.rs).
CREATE TABLE "media_file"
(
    id                      varchar(255)                         not null
        primary key,
    path                    varchar(255)           default ''    not null,
    title                   varchar(255)           default ''    not null,
    album                   varchar(255)           default ''    not null,
    artist                  varchar(255)           default ''    not null,
    artist_id               varchar(255)           default ''    not null,
    album_artist            varchar(255)           default ''    not null,
    album_id                varchar(255)           default ''    not null,
    has_cover_art           bool                   default FALSE not null,
    track_number            integer                default 0     not null,
    disc_number             integer                default 0     not null,
    year                    integer                default 0     not null,
    size                    integer                default 0     not null,
    suffix                  varchar(255)           default ''    not null,
    duration                real                   default 0     not null,
    bit_rate                integer                default 0     not null,
    genre                   varchar(255)           default ''    not null,
    compilation             bool                   default FALSE not null,
    created_at              datetime,
    updated_at              datetime,
    full_text               varchar(255)           default '',
    album_artist_id         varchar(255)           default '',
    date                    varchar(255)           default ''    not null,
    original_year           int                    default 0     not null,
    original_date           varchar(255)           default ''    not null,
    release_year            int                    default 0     not null,
    release_date            varchar(255)           default ''    not null,
    order_album_name        varchar collate NOCASE default ''    not null,
    order_album_artist_name varchar collate NOCASE default ''    not null,
    order_artist_name       varchar collate NOCASE default ''    not null,
    sort_album_name         varchar collate NOCASE default ''    not null,
    sort_artist_name        varchar collate NOCASE default ''    not null,
    sort_album_artist_name  varchar collate NOCASE default ''    not null,
    sort_title              varchar collate NOCASE default ''    not null,
    disc_subtitle           varchar                default ''    not null,
    catalog_num             varchar                default ''    not null,
    comment                 varchar                default ''    not null,
    order_title             varchar collate NOCASE default ''    not null,
    mbz_recording_id        varchar                default ''    not null,
    mbz_album_id            varchar                default ''    not null,
    mbz_artist_id           varchar                default ''    not null,
    mbz_album_artist_id     varchar                default ''    not null,
    mbz_album_type          varchar                default ''    not null,
    mbz_album_comment       varchar                default ''    not null,
    mbz_release_track_id    varchar                default ''    not null,
    channels                integer                default 0     not null,
    lyrics                  jsonb                  default '[]'  not null,
    sample_rate             integer                default 0     not null,
    library_id              integer                default 1     not null
        references library
            on delete cascade
, folder_id varchar default '' not null, pid varchar default '' not null, missing boolean default false not null, mbz_release_group_id varchar default '' not null, tags jsonb default '{}' not null, participants jsonb default '{}' not null, explicit_status varchar default '' not null, birth_time datetime default current_timestamp not null, rg_album_gain real, rg_album_peak real, rg_track_gain real, rg_track_peak real, average_rating REAL NOT NULL DEFAULT 0, search_participants TEXT NOT NULL DEFAULT '', search_normalized TEXT NOT NULL DEFAULT '', codec VARCHAR(255) DEFAULT '' NOT NULL, probe_data TEXT DEFAULT '' NOT NULL, bpm integer, bit_depth integer);
CREATE TABLE "album"
(
    id                       varchar(255)                         not null
        primary key,
    name                     varchar(255)           default ''    not null,
    embed_art_path           varchar(255)           default ''    not null,
    album_artist             varchar(255)           default ''    not null,
    min_year                 int                    default 0     not null,
    max_year                 integer                default 0     not null,
    compilation              bool                   default FALSE not null,
    song_count               integer                default 0     not null,
    duration                 real                   default 0     not null,
    genre                    varchar(255)           default ''    not null,
    created_at               datetime,
    updated_at               datetime,
    full_text                varchar(255)           default '',
    album_artist_id          varchar(255)           default '',
    size                     integer                default 0     not null,
    description              varchar(255)           default ''    not null,
    small_image_url          varchar(255)           default ''    not null,
    medium_image_url         varchar(255)           default ''    not null,
    large_image_url          varchar(255)           default ''    not null,
    external_url             varchar(255)           default ''    not null,
    external_info_updated_at datetime,
    date                     varchar(255)           default ''    not null,
    min_original_year        int                    default 0     not null,
    max_original_year        int                    default 0     not null,
    original_date            varchar(255)           default ''    not null,
    release_date             varchar(255)           default ''    not null,
    releases                 integer                default 0     not null,
    order_album_name         varchar collate NOCASE default ''    not null,
    order_album_artist_name  varchar collate NOCASE default ''    not null,
    sort_album_name          varchar collate NOCASE default ''    not null,
    sort_album_artist_name   varchar collate NOCASE default ''    not null,
    catalog_num              varchar                default ''    not null,
    comment                  varchar                default ''    not null,
    mbz_album_id             varchar                default ''    not null,
    mbz_album_artist_id      varchar                default ''    not null,
    mbz_album_type           varchar                default ''    not null,
    mbz_album_comment        varchar                default ''    not null,
    discs                    jsonb                  default '{}'  not null,
    library_id               integer                default 1     not null
        references library
            on delete cascade
, imported_at datetime default '0000-00-00 00:00:00' not null, missing boolean default false not null, mbz_release_group_id varchar default '' not null, tags jsonb default '{}' not null, participants jsonb default '{}' not null, folder_ids jsonb default '[]' not null, explicit_status varchar default '' not null, average_rating REAL NOT NULL DEFAULT 0, search_participants TEXT NOT NULL DEFAULT '', search_normalized TEXT NOT NULL DEFAULT '', rg_album_gain real, rg_album_peak real);
CREATE TABLE "artist"
(
    id                       varchar(255)                      not null
        primary key,
    name                     varchar(255)           default '' not null,
    full_text                varchar(255)           default '',
    biography                varchar(255)           default '' not null,
    small_image_url          varchar(255)           default '' not null,
    medium_image_url         varchar(255)           default '' not null,
    large_image_url          varchar(255)           default '' not null,
    external_url             varchar(255)           default '' not null,
    external_info_updated_at datetime,
    order_artist_name        varchar collate NOCASE default '' not null,
    sort_artist_name         varchar collate NOCASE default '' not null,
    mbz_artist_id            varchar                default '' not null
, missing boolean default false not null, similar_artists jsonb default '[]' not null, updated_at datetime default current_time not null, created_at datetime default current_time not null, average_rating REAL NOT NULL DEFAULT 0, search_normalized TEXT NOT NULL DEFAULT '', uploaded_image VARCHAR(255) DEFAULT '');
CREATE TABLE "library_artist"
(
    library_id integer NOT NULL DEFAULT 1
        REFERENCES library(id) ON DELETE CASCADE,
    artist_id varchar NOT NULL
        REFERENCES artist(id) ON DELETE CASCADE,
    stats text DEFAULT '{}',
    CONSTRAINT library_artist_ux UNIQUE (library_id, artist_id)
);
CREATE TABLE "annotation"
(
	user_id     varchar(255)    not null
        REFERENCES user(id)
            ON DELETE CASCADE
            ON UPDATE CASCADE,
	item_id     varchar(255)    default '' not null,
	item_type   varchar(255)    default '' not null,
	play_count  integer         default 0,
	play_date   datetime,
	rating      integer         default 0,
	starred     bool            default FALSE not null,
	starred_at  datetime, rated_at datetime,
	unique (user_id, item_id, item_type)
);
CREATE TABLE bookmark
(
    user_id    varchar(255) not null
        references user
            on update cascade on delete cascade,
    item_id    varchar(255) not null,
    item_type  varchar(255) not null,
    comment    varchar(255),
    position   integer,
    changed_by varchar(255),
    created_at datetime,
    updated_at datetime,
    constraint bookmark_pk
        unique (user_id, item_id, item_type)
);
CREATE TABLE item_artwork (
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  image_type TEXT NOT NULL DEFAULT 'primary',
  hash TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  ref_mtime INTEGER NOT NULL DEFAULT 0,
  attempted_at TIMESTAMP,
  updated_at TIMESTAMP, trace jsonb NOT NULL DEFAULT '[]', last_failure jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (item_kind, item_id, image_type)
) WITHOUT ROWID;
CREATE TABLE artwork (
  hash TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  blur_hash TEXT NOT NULL DEFAULT '',
  thumb_hash TEXT NOT NULL DEFAULT '',
  dominant_color TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "player"
(
	id varchar(255) not null
		primary key,
	name varchar not null,
	user_agent varchar,
	user_id varchar not null
		references user (id)
			on update cascade on delete cascade,
	client varchar not null,
	ip varchar,
	last_seen timestamp,
	max_bit_rate int default 0,
	transcoding_id varchar,
	report_real_path bool default FALSE not null,
	scrobble_enabled bool default true
);
CREATE TABLE transcoding
(
	id varchar(255) not null primary key,
	name varchar(255) not null,
	target_format varchar(255) not null,
	command varchar(255) default '' not null,
	default_bit_rate int default 192,
	unique (name),
	unique (target_format)
);
CREATE TABLE tag(
  	id varchar not null primary key,
  	tag_name varchar default '' not null,
  	tag_value varchar default '' not null,
  	constraint tags_name_value
		unique (tag_name, tag_value)
);
CREATE TABLE album_tags(
    album_id varchar not null
        references album (id) on delete cascade,
    tag_id varchar not null
        references tag (id) on delete cascade,
    constraint album_tags unique (album_id, tag_id)
);
CREATE TABLE media_file_tags(
    media_file_id varchar not null
        references media_file (id) on delete cascade,
    tag_id varchar not null
        references tag (id) on delete cascade,
    constraint media_file_tags unique (media_file_id, tag_id)
);
CREATE TABLE "playlist"
(
    id           varchar(255)                              not null
        primary key,
    name         varchar(255) collate NOCASE default ''    not null,
    comment      varchar(255)                default ''    not null,
    duration     real                        default 0     not null,
    song_count   integer                     default 0     not null,
    public       bool                        default FALSE not null,
    created_at   datetime,
    updated_at   datetime,
    path         string                      default ''    not null,
    sync         bool                        default false not null,
    size         integer                     default 0     not null,
    rules        varchar,
    evaluated_at datetime,
    owner_id     varchar(255)                              not null
        constraint playlist_user_user_id_fk
            references user
            on update cascade on delete cascade
, uploaded_image VARCHAR(255) DEFAULT '', external_image_url VARCHAR(255) DEFAULT '', average_rating REAL NOT NULL DEFAULT 0, imported_hash varchar default '' not null);
CREATE TABLE "playlist_tracks"
(
	id integer default 0 not null,
	playlist_id varchar(255) not null
		constraint playlist_tracks_playlist_id_fk
			references playlist
				on update cascade on delete cascade,
	media_file_id varchar(255) not null
);
CREATE TABLE "playqueue"(
    id varchar(255) not null,
    user_id varchar(255) not null
        references user(id)
        on update cascade on delete cascade,
    current integer not null default 0,
    changed_by varchar(255),
    items varchar(255),
    created_at datetime,
    updated_at datetime
, position integer);
CREATE VIRTUAL TABLE album_fts USING fts5(
			name, sort_album_name, album_artist,
			search_participants, discs, catalog_num, album_version, search_normalized,
			content='', content_rowid='rowid',
			tokenize='unicode61 remove_diacritics 2'
		);
CREATE VIRTUAL TABLE artist_fts USING fts5(
			name, sort_artist_name, search_normalized,
			content='', content_rowid='rowid',
			tokenize='unicode61 remove_diacritics 2'
		);
CREATE VIRTUAL TABLE media_file_fts USING fts5(
			title, album, artist, album_artist,
			sort_title, sort_album_name, sort_artist_name, sort_album_artist_name,
			disc_subtitle, search_participants, search_normalized,
			content='', content_rowid='rowid',
			tokenize='unicode61 remove_diacritics 2'
		);
CREATE TRIGGER album_fts_ad AFTER DELETE ON album BEGIN
			INSERT INTO album_fts(album_fts, rowid, name, sort_album_name, album_artist,
				search_participants, discs, catalog_num, album_version, search_normalized)
			VALUES ('delete', OLD.rowid, OLD.name, COALESCE(OLD.sort_album_name, ''), COALESCE(OLD.album_artist, ''),
				COALESCE(OLD.search_participants, ''), COALESCE(OLD.discs, ''),
				COALESCE(OLD.catalog_num, ''),
				COALESCE((SELECT group_concat(json_extract(je.value, '$.value'), ' ')
					FROM json_each(OLD.tags, '$.albumversion') AS je), ''),
				COALESCE(OLD.search_normalized, ''));
		END;
CREATE TRIGGER album_fts_ai AFTER INSERT ON album BEGIN
			INSERT INTO album_fts(rowid, name, sort_album_name, album_artist,
				search_participants, discs, catalog_num, album_version, search_normalized)
			VALUES (NEW.rowid, NEW.name, COALESCE(NEW.sort_album_name, ''), COALESCE(NEW.album_artist, ''),
				COALESCE(NEW.search_participants, ''), COALESCE(NEW.discs, ''),
				COALESCE(NEW.catalog_num, ''),
				COALESCE((SELECT group_concat(json_extract(je.value, '$.value'), ' ')
					FROM json_each(NEW.tags, '$.albumversion') AS je), ''),
				COALESCE(NEW.search_normalized, ''));
		END;
CREATE TRIGGER album_fts_au AFTER UPDATE ON album
		WHEN
			OLD.name IS NOT NEW.name OR
			OLD.sort_album_name IS NOT NEW.sort_album_name OR
			OLD.album_artist IS NOT NEW.album_artist OR
			OLD.search_participants IS NOT NEW.search_participants OR
			OLD.discs IS NOT NEW.discs OR
			OLD.catalog_num IS NOT NEW.catalog_num OR
			OLD.tags IS NOT NEW.tags OR
			OLD.search_normalized IS NOT NEW.search_normalized
		BEGIN
			INSERT INTO album_fts(album_fts, rowid, name, sort_album_name, album_artist,
				search_participants, discs, catalog_num, album_version, search_normalized)
			VALUES ('delete', OLD.rowid, OLD.name, COALESCE(OLD.sort_album_name, ''), COALESCE(OLD.album_artist, ''),
				COALESCE(OLD.search_participants, ''), COALESCE(OLD.discs, ''),
				COALESCE(OLD.catalog_num, ''),
				COALESCE((SELECT group_concat(json_extract(je.value, '$.value'), ' ')
					FROM json_each(OLD.tags, '$.albumversion') AS je), ''),
				COALESCE(OLD.search_normalized, ''));
			INSERT INTO album_fts(rowid, name, sort_album_name, album_artist,
				search_participants, discs, catalog_num, album_version, search_normalized)
			VALUES (NEW.rowid, NEW.name, COALESCE(NEW.sort_album_name, ''), COALESCE(NEW.album_artist, ''),
				COALESCE(NEW.search_participants, ''), COALESCE(NEW.discs, ''),
				COALESCE(NEW.catalog_num, ''),
				COALESCE((SELECT group_concat(json_extract(je.value, '$.value'), ' ')
					FROM json_each(NEW.tags, '$.albumversion') AS je), ''),
				COALESCE(NEW.search_normalized, ''));
		END;
CREATE TRIGGER artist_fts_ad AFTER DELETE ON artist BEGIN
			INSERT INTO artist_fts(artist_fts, rowid, name, sort_artist_name, search_normalized)
			VALUES ('delete', OLD.rowid, OLD.name, COALESCE(OLD.sort_artist_name, ''),
				COALESCE(OLD.search_normalized, ''));
		END;
CREATE TRIGGER artist_fts_ai AFTER INSERT ON artist BEGIN
			INSERT INTO artist_fts(rowid, name, sort_artist_name, search_normalized)
			VALUES (NEW.rowid, NEW.name, COALESCE(NEW.sort_artist_name, ''),
				COALESCE(NEW.search_normalized, ''));
		END;
CREATE TRIGGER artist_fts_au AFTER UPDATE ON artist
		WHEN
			OLD.name IS NOT NEW.name OR
			OLD.sort_artist_name IS NOT NEW.sort_artist_name OR
			OLD.search_normalized IS NOT NEW.search_normalized
		BEGIN
			INSERT INTO artist_fts(artist_fts, rowid, name, sort_artist_name, search_normalized)
			VALUES ('delete', OLD.rowid, OLD.name, COALESCE(OLD.sort_artist_name, ''),
				COALESCE(OLD.search_normalized, ''));
			INSERT INTO artist_fts(rowid, name, sort_artist_name, search_normalized)
			VALUES (NEW.rowid, NEW.name, COALESCE(NEW.sort_artist_name, ''),
				COALESCE(NEW.search_normalized, ''));
		END;
CREATE TRIGGER media_file_fts_ad AFTER DELETE ON media_file BEGIN
			INSERT INTO media_file_fts(media_file_fts, rowid, title, album, artist, album_artist,
				sort_title, sort_album_name, sort_artist_name, sort_album_artist_name,
				disc_subtitle, search_participants, search_normalized)
			VALUES ('delete', OLD.rowid, OLD.title, OLD.album, OLD.artist, OLD.album_artist,
				OLD.sort_title, OLD.sort_album_name, OLD.sort_artist_name, OLD.sort_album_artist_name,
				COALESCE(OLD.disc_subtitle, ''), COALESCE(OLD.search_participants, ''),
				COALESCE(OLD.search_normalized, ''));
		END;
CREATE TRIGGER media_file_fts_ai AFTER INSERT ON media_file BEGIN
			INSERT INTO media_file_fts(rowid, title, album, artist, album_artist,
				sort_title, sort_album_name, sort_artist_name, sort_album_artist_name,
				disc_subtitle, search_participants, search_normalized)
			VALUES (NEW.rowid, NEW.title, NEW.album, NEW.artist, NEW.album_artist,
				NEW.sort_title, NEW.sort_album_name, NEW.sort_artist_name, NEW.sort_album_artist_name,
				COALESCE(NEW.disc_subtitle, ''), COALESCE(NEW.search_participants, ''),
				COALESCE(NEW.search_normalized, ''));
		END;
CREATE TRIGGER media_file_fts_au AFTER UPDATE ON media_file
		WHEN
			OLD.title IS NOT NEW.title OR
			OLD.album IS NOT NEW.album OR
			OLD.artist IS NOT NEW.artist OR
			OLD.album_artist IS NOT NEW.album_artist OR
			OLD.sort_title IS NOT NEW.sort_title OR
			OLD.sort_album_name IS NOT NEW.sort_album_name OR
			OLD.sort_artist_name IS NOT NEW.sort_artist_name OR
			OLD.sort_album_artist_name IS NOT NEW.sort_album_artist_name OR
			OLD.disc_subtitle IS NOT NEW.disc_subtitle OR
			OLD.search_participants IS NOT NEW.search_participants OR
			OLD.search_normalized IS NOT NEW.search_normalized
		BEGIN
			INSERT INTO media_file_fts(media_file_fts, rowid, title, album, artist, album_artist,
				sort_title, sort_album_name, sort_artist_name, sort_album_artist_name,
				disc_subtitle, search_participants, search_normalized)
			VALUES ('delete', OLD.rowid, OLD.title, OLD.album, OLD.artist, OLD.album_artist,
				OLD.sort_title, OLD.sort_album_name, OLD.sort_artist_name, OLD.sort_album_artist_name,
				COALESCE(OLD.disc_subtitle, ''), COALESCE(OLD.search_participants, ''),
				COALESCE(OLD.search_normalized, ''));
			INSERT INTO media_file_fts(rowid, title, album, artist, album_artist,
				sort_title, sort_album_name, sort_artist_name, sort_album_artist_name,
				disc_subtitle, search_participants, search_normalized)
			VALUES (NEW.rowid, NEW.title, NEW.album, NEW.artist, NEW.album_artist,
				NEW.sort_title, NEW.sort_album_name, NEW.sort_artist_name, NEW.sort_album_artist_name,
				COALESCE(NEW.disc_subtitle, ''), COALESCE(NEW.search_participants, ''),
				COALESCE(NEW.search_normalized, ''));
		END;


-- phase 4: what a write may touch (a radio station's id is found by the star lookup; plays go to scrobbles)
CREATE TABLE "radio"
(
    id            varchar(255)           not null
        primary key,
    name          varchar collate NOCASE not null
        unique,
    stream_url    varchar                not null,
    home_page_url varchar default ''     not null,
    created_at    datetime,
    updated_at    datetime
, uploaded_image VARCHAR(255) NOT NULL DEFAULT '');

CREATE TABLE "scrobbles"(
    id INTEGER PRIMARY KEY,
    media_file_id VARCHAR(255) NOT NULL
        REFERENCES media_file(id)
            ON DELETE CASCADE
            ON UPDATE CASCADE,
    user_id VARCHAR(255) NOT NULL 
        REFERENCES user(id)
            ON DELETE CASCADE
            ON UPDATE CASCADE,
    submission_time INTEGER NOT NULL
);

-- a playlist whose songs change has its cover queued for Navidrome's artwork worker
CREATE UNIQUE INDEX playlist_tracks_pos
	on playlist_tracks (playlist_id, id);
CREATE TABLE artwork_queue (
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  image_type TEXT NOT NULL DEFAULT 'primary',
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enqueued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, trace jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (item_kind, item_id, image_type)
) WITHOUT ROWID;
CREATE INDEX ix_artwork_queue_drain ON artwork_queue(item_kind, priority DESC, enqueued_at, retry_at);

-- folders and their image files (phase 5: disc covers)
CREATE TABLE folder( id varchar not null primary key, library_id integer not null references library (id) on delete cascade, path varchar default '' not null, name varchar default '' not null, missing boolean default false not null, parent_id varchar default '' not null, num_audio_files integer default 0 not null, num_playlists integer default 0 not null, image_files jsonb default '[]' not null, images_updated_at datetime default '0000-00-00 00:00:00' not null, updated_at datetime default (datetime(current_timestamp, 'localtime')) not null, created_at datetime default (datetime(current_timestamp, 'localtime')) not null , hash varchar default '' not null);
CREATE INDEX folder_parent_id on folder(parent_id);
