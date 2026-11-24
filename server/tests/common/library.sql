-- The library's tables as the frozen Navidrome (0.64.2-sonus.10) makes them: the CREATE statements of a database the
-- fork made (tools/fixtures), unchanged. For the tests of server/src/library (tests/library.rs).
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
