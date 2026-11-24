// The fixture library: every file, its tags, and the stable keys tests find it by (the manifest maps them to the ids a
// server gives). Fictitious artists and titles throughout. README.md describes the cases in prose; keep them in step.
//
// A track: { path (under the music folder), format (lib/formats.mjs), seconds, freq, tags (lib/tags.mjs), cover
// ('folder' | 'embedded' names a JPEG below, embedded in the file), keys: [manifest keys for the track] }.
// An album key names the album its first track lands in; an artist key names an artist by name.

export const COVERS = {
  folder: 'tools/demo-server/covers/al0.jpg',   // written as cover.jpg next to an album's files
  embedded: 'tools/demo-server/covers/al12.jpg', // embedded in files
};

const MBZ = {
  aurora: '0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5e01',
  northernLights: '0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5e02',
  northernLightsGroup: '0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5e03',
};
const RG = { albumGain: '-7.10 dB', albumPeak: '0.977000' };

// Synced lyrics: LRC text with an [offset:] (positive: the lyrics come earlier, as OpenSubsonic has it).
const LRC_EMBEDDED = ['[ar:Aurora Lane]', '[ti:Magnetic Field]', '[offset:+500]',
  '[00:00.50]Field lines bend', '[00:01.50]Toward the pole', '[00:02.50]And hold'].join('\n');
export const LRC_SIDECAR = ['[ar:Aurora Lane]', '[ti:First Light]', '[offset:-250]',
  '[00:00.20]Morning comes slow', '[00:01.20]Over the snow', '[00:02.20]First light'].join('\n');

const northern = (n, title, extra = {}) => ({
  title, artist: 'Aurora Lane', albumArtist: 'Aurora Lane', album: 'Northern Lights', track: [n, 3], disc: [1, 1],
  date: '2019-06-14', originalDate: '2015-03-01', genres: ['Electronic', 'Ambient'],
  sort: { artist: 'Lane, Aurora', albumArtist: 'Lane, Aurora' }, bpm: 96 + n,
  replayGain: { trackGain: `-${6 + n}.20 dB`, trackPeak: `0.9${n}0000`, ...RG },
  mbz: { recording: `0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d5f0${n}`, releaseTrack: `0f3d6a8e-5c1b-4d2a-9e7f-1a2b3c4d6f0${n}`,
    album: MBZ.northernLights, artist: MBZ.aurora, albumArtist: MBZ.aurora, releaseGroup: MBZ.northernLightsGroup },
  ...extra,
});

const summer = (n, title, artist, extra = {}) => ({
  title, artist, album: 'Summer Hits', track: [n, 4], date: '2021-07-01', genres: ['Pop'], compilation: true, ...extra,
});

const twin = (disc, n, title, subtitle) => ({
  title, artist: 'Kenji Mori', albumArtist: 'Kenji Mori', album: 'Twin Discs', track: [n, 2], disc: [disc, 2],
  discSubtitle: subtitle, date: '2020-11-01', genres: ['Jazz', 'Fusion'],
});

export const TRACKS = [
  // A normal album: FLAC, a folder cover.jpg, one track with its own embedded cover, ReplayGain, MusicBrainz ids,
  // an original date older than the release date, two genres, sort names; lyrics as a sidecar and embedded.
  { path: 'Aurora Lane/Northern Lights/01 - First Light.flac', format: 'flac', seconds: 3, freq: 440,
    tags: northern(1, 'First Light'), lrc: LRC_SIDECAR,
    keys: ['track.flac', 'track.replayGain', 'track.musicBrainz', 'track.lrcSidecar', 'track.originalDate'],
    albumKeys: ['album.normal', 'album.folderCover'] },
  { path: 'Aurora Lane/Northern Lights/02 - Polar Night.flac', format: 'flac', seconds: 3.5, freq: 494, cover: 'embedded',
    tags: northern(2, 'Polar Night'), keys: ['track.embeddedCoverOverFolder'] },
  { path: 'Aurora Lane/Northern Lights/03 - Magnetic Field.flac', format: 'flac', seconds: 4, freq: 523,
    tags: northern(3, 'Magnetic Field', { lyrics: { lang: 'eng', text: LRC_EMBEDDED } }), keys: ['track.syncedLyrics'] },

  // A compilation: Various Artists (COMPILATION=1 and no album artist: the server names it), MP3, every file with an
  // embedded cover and no folder cover; several artists written three ways.
  { path: 'Various Artists/Summer Hits/01 - Sunrise Duet.mp3', format: 'mp3', seconds: 3, cover: 'embedded',
    tags: summer(1, 'Sunrise Duet', 'Aurora Lane / Kenji Mori', { genres: ['Pop', 'Dance'] }),
    keys: ['track.mp3', 'track.slashArtists', 'track.embeddedCover', 'track.twoGenres'], albumKeys: ['album.compilation'] },
  { path: 'Various Artists/Summer Hits/02 - Night Drive.mp3', format: 'mp3', seconds: 3.5, cover: 'embedded',
    tags: summer(2, 'Night Drive', 'Kenji Mori feat. Lumi'), keys: ['track.feat'] },
  { path: 'Various Artists/Summer Hits/03 - Two Voices.mp3', format: 'mp3', seconds: 3, cover: 'embedded',
    tags: summer(3, 'Two Voices', 'Lumi & Dax', { artists: ['Lumi', 'Dax'] }), keys: ['track.artistsTag'] },
  { path: 'Various Artists/Summer Hits/04 - Hello Summer.mp3', format: 'mp3', seconds: 4, cover: 'embedded',
    tags: summer(4, 'Hello Summer', 'Dax', { lyrics: { lang: 'eng', text: 'Hello summer\nHello sun\nUnsynced words' } }),
    keys: ['track.unsyncedLyrics'] },

  // Two discs, in CD1 and CD2 folders, with disc subtitles: M4A (AAC).
  { path: 'Kenji Mori/Twin Discs/CD1/01 - Side A Opening.m4a', format: 'm4a', seconds: 3, tags: twin(1, 1, 'Side A Opening', 'Day'),
    keys: ['track.m4a', 'track.disc1'], albumKeys: ['album.twoDiscs'] },
  { path: 'Kenji Mori/Twin Discs/CD1/02 - Blue Hour.m4a', format: 'm4a', seconds: 3.5, tags: twin(1, 2, 'Blue Hour', 'Day'), keys: [] },
  { path: 'Kenji Mori/Twin Discs/CD2/01 - Side B Opening.m4a', format: 'm4a', seconds: 3, tags: twin(2, 1, 'Side B Opening', 'Night'),
    keys: ['track.disc2'] },
  { path: 'Kenji Mori/Twin Discs/CD2/02 - Last Call.m4a', format: 'm4a', seconds: 4, cover: 'embedded',
    tags: twin(2, 2, 'Last Call', 'Night'), keys: ['track.m4aCover'] },

  // The same album name by two artists: Ogg Vorbis and Opus, both with embedded covers.
  { path: 'Aurora Lane/Greatest Hits/01 - Aurora.ogg', format: 'ogg', seconds: 3, cover: 'embedded',
    tags: { title: 'Aurora', artist: 'Aurora Lane', albumArtist: 'Aurora Lane', album: 'Greatest Hits', track: [1, 2], date: '2022', genres: ['Rock'] },
    keys: ['track.ogg'], albumKeys: ['album.sameName.aurora'] },
  { path: 'Aurora Lane/Greatest Hits/02 - Lane Change.ogg', format: 'ogg', seconds: 3.5,
    tags: { title: 'Lane Change', artist: 'Aurora Lane', albumArtist: 'Aurora Lane', album: 'Greatest Hits', track: [2, 2], date: '2022', genres: ['Rock'] },
    keys: [] },
  { path: 'Kenji Mori/Greatest Hits/01 - Mori Theme.opus', format: 'opus', seconds: 3, cover: 'embedded',
    tags: { title: 'Mori Theme', artist: 'Kenji Mori', albumArtist: 'Kenji Mori', album: 'Greatest Hits', track: [1, 2], date: '2023', genres: ['Rock'] },
    keys: ['track.opus'], albumKeys: ['album.sameName.kenji'] },
  { path: 'Kenji Mori/Greatest Hits/02 - Forest Walk.opus', format: 'opus', seconds: 3.5,
    tags: { title: 'Forest Walk', artist: 'Kenji Mori', albumArtist: 'Kenji Mori', album: 'Greatest Hits', track: [2, 2], date: '2023', genres: ['Rock'] },
    keys: [] },

  // CJK: Chinese, Japanese and Korean titles, a Chinese artist with a Latin sort name.
  ...[['夜行列车', 'track.cjk'], ['雨の日の手紙', 'track.japanese'], ['별빛 아래서', 'track.korean']].map(([title, key], i) => ({
    path: `林夕雨/城市的灯火/0${i + 1} - ${title}.flac`, format: 'flac', seconds: 3 + i / 2, freq: 330 + 40 * i,
    tags: { title, artist: '林夕雨', albumArtist: '林夕雨', album: '城市的灯火', track: [i + 1, 3], date: '2018', genres: ['C-Pop'],
      sort: { artist: 'Lin Xiyu', albumArtist: 'Lin Xiyu', album: 'Chengshi de Denghuo' } },
    keys: [key], albumKeys: i === 0 ? ['album.cjk'] : [],
  })),

  // Accented Latin: MP3.
  ...[['Été à Paris', 'track.accented'], ['Über den Wolken', 'track.umlaut'], ['Ñandú Señorial', 'track.tilde']].map(([title, key], i) => ({
    path: `Zoë Ångström/Café Mélodie/0${i + 1} - ${title}.mp3`, format: 'mp3', seconds: 3,
    tags: { title, artist: 'Zoë Ångström', albumArtist: 'Zoë Ångström', album: 'Café Mélodie', track: [i + 1, 3], date: '2017', genres: ['Chanson'] },
    keys: [key], albumKeys: i === 0 ? ['album.accented'] : [],
  })),

  // Turkish dotted and dotless I (Go lowercases İ to "i", Rust to "i̇"): WAV with an ID3 chunk.
  ...[['İnce Yol', 'track.turkish'], ['Işık', 'track.dotlessI'], ['IRMAK', 'track.upperI']].map(([title, key], i) => ({
    path: `İlkay Işık/İstanbul Işıkları/0${i + 1} - ${title}.wav`, format: 'wav', seconds: 2.5, freq: 392 + 20 * i,
    tags: { title, artist: 'İlkay Işık', albumArtist: 'İlkay Işık', album: 'İstanbul Işıkları', track: [i + 1, 3], date: '2016', genres: ['Anatolian Rock'] },
    keys: i === 0 ? [key, 'track.wav'] : [key], albumKeys: i === 0 ? ['album.turkish'] : [],
  })),

  // Missing tags: no album, no artist, nothing at all (the title then comes from the file name).
  { path: 'Unsorted/Lonely Track.mp3', format: 'mp3', seconds: 3, tags: { title: 'Lonely Track', artist: 'Aurora Lane' }, keys: ['track.noAlbum'] },
  { path: 'Unsorted/Anonymous.flac', format: 'flac', seconds: 3, freq: 600, tags: { title: 'Anonymous Song', album: 'Orphans' }, keys: ['track.noArtist'] },
  { path: 'Unsorted/untagged.ogg', format: 'ogg', seconds: 3, tags: {}, keys: ['track.noTags'] },
];

/** Artists the manifest names: key → name as the server should list it. */
export const ARTISTS = {
  'artist.aurora': 'Aurora Lane',
  'artist.kenji': 'Kenji Mori',
  'artist.lumi': 'Lumi',
  'artist.dax': 'Dax',
  'artist.cjk': '林夕雨',
  'artist.accented': 'Zoë Ångström',
  'artist.turkish': 'İlkay Işık',
};
