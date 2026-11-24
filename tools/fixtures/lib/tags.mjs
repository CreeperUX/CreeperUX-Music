// One description of a track's tags (library.mjs), written out as each format names them: Vorbis comments (FLAC, Ogg
// Vorbis, Opus), ID3v2.4 frames (MP3, WAV) and iTunes atoms (M4A). Names follow MusicBrainz Picard's tag map, which is
// what Navidrome's resources/mappings.yaml reads.
//
// The description: { title, artist, artists: [], albumArtist, album, track: [n, total], disc: [n, total], date,
// originalDate, genres: [], compilation, sort: { artist, albumArtist, album, title }, comment, bpm,
// lyrics: { lang, text }, replayGain: { trackGain, trackPeak, albumGain, albumPeak },
// mbz: { recording, releaseTrack, album, artist, albumArtist, releaseGroup }, discSubtitle }. Every field is optional.

const MBZ_VORBIS = { recording: 'MUSICBRAINZ_TRACKID', releaseTrack: 'MUSICBRAINZ_RELEASETRACKID', album: 'MUSICBRAINZ_ALBUMID',
  artist: 'MUSICBRAINZ_ARTISTID', albumArtist: 'MUSICBRAINZ_ALBUMARTISTID', releaseGroup: 'MUSICBRAINZ_RELEASEGROUPID' };
const MBZ_TXXX = { releaseTrack: 'MusicBrainz Release Track Id', album: 'MusicBrainz Album Id', artist: 'MusicBrainz Artist Id',
  albumArtist: 'MusicBrainz Album Artist Id', releaseGroup: 'MusicBrainz Release Group Id' };
const MBZ_MP4 = { recording: 'MusicBrainz Track Id', ...MBZ_TXXX };
const RG = { trackGain: 'REPLAYGAIN_TRACK_GAIN', trackPeak: 'REPLAYGAIN_TRACK_PEAK', albumGain: 'REPLAYGAIN_ALBUM_GAIN', albumPeak: 'REPLAYGAIN_ALBUM_PEAK' };

/** [name, value] pairs for a Vorbis comment block, in a fixed order. */
export function vorbisComments(t) {
  const out = [], add = (k, v) => { if (v !== undefined && v !== null && v !== '') out.push([k, String(v)]); };
  add('TITLE', t.title);
  add('ARTIST', t.artist);
  for (const a of t.artists ?? []) add('ARTISTS', a);
  add('ALBUMARTIST', t.albumArtist);
  add('ALBUM', t.album);
  if (t.track) { add('TRACKNUMBER', t.track[0]); add('TRACKTOTAL', t.track[1]); }
  if (t.disc) { add('DISCNUMBER', t.disc[0]); add('DISCTOTAL', t.disc[1]); }
  add('DISCSUBTITLE', t.discSubtitle);
  add('DATE', t.date);
  add('ORIGINALDATE', t.originalDate);
  for (const g of t.genres ?? []) add('GENRE', g);
  if (t.compilation) add('COMPILATION', '1');
  add('ARTISTSORT', t.sort?.artist);
  add('ALBUMARTISTSORT', t.sort?.albumArtist);
  add('ALBUMSORT', t.sort?.album);
  add('TITLESORT', t.sort?.title);
  add('COMMENT', t.comment);
  add('BPM', t.bpm);
  for (const [k, name] of Object.entries(RG)) add(name, t.replayGain?.[k]);
  for (const [k, name] of Object.entries(MBZ_VORBIS)) add(name, t.mbz?.[k]);
  add('LYRICS', t.lyrics?.text);
  return out;
}

// ---------------------------------------------------------------- ID3v2.4

const syncsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const utf8 = s => Buffer.from(s, 'utf8'), latin1 = s => Buffer.from(s, 'latin1'), Z = Buffer.from([0]), UTF8 = Buffer.from([3]);
const frame = (id, body) => Buffer.concat([latin1(id), syncsafe(body.length), Buffer.from([0, 0]), body]);
// Several values in one text frame are separated by a null, as ID3v2.4 has it.
const text = (id, values) => frame(id, Buffer.concat([UTF8, utf8([values].flat().map(String).join('\0'))]));
const txxx = (desc, values) => frame('TXXX', Buffer.concat([UTF8, utf8(desc), Z, utf8([values].flat().map(String).join('\0'))]));
const withLanguage = (id, lang, desc, body) => frame(id, Buffer.concat([UTF8, latin1(lang.padEnd(3).slice(0, 3)), utf8(desc), Z, utf8(body)]));

/** A whole ID3v2.4 tag ("ID3" header and frames), with an optional JPEG front cover. */
export function id3v2(t, cover) {
  const f = [], has = v => v !== undefined && v !== null && v !== '';
  if (has(t.title)) f.push(text('TIT2', t.title));
  if (has(t.artist)) f.push(text('TPE1', t.artist));
  if (t.artists?.length) f.push(txxx('ARTISTS', t.artists));
  if (has(t.albumArtist)) f.push(text('TPE2', t.albumArtist));
  if (has(t.album)) f.push(text('TALB', t.album));
  if (t.track) f.push(text('TRCK', t.track.filter(has).join('/')));
  if (t.disc) f.push(text('TPOS', t.disc.filter(has).join('/')));
  if (has(t.discSubtitle)) f.push(text('TSST', t.discSubtitle));
  if (has(t.date)) f.push(text('TDRC', t.date));
  if (has(t.originalDate)) f.push(text('TDOR', t.originalDate));
  if (t.genres?.length) f.push(text('TCON', t.genres));
  if (t.compilation) f.push(text('TCMP', '1'));
  if (has(t.sort?.artist)) f.push(text('TSOP', t.sort.artist));
  if (has(t.sort?.albumArtist)) f.push(text('TSO2', t.sort.albumArtist));
  if (has(t.sort?.album)) f.push(text('TSOA', t.sort.album));
  if (has(t.sort?.title)) f.push(text('TSOT', t.sort.title));
  if (has(t.comment)) f.push(withLanguage('COMM', 'eng', '', t.comment));
  if (has(t.bpm)) f.push(text('TBPM', t.bpm));
  for (const [k, name] of Object.entries(RG)) if (has(t.replayGain?.[k])) f.push(txxx(name, t.replayGain[k]));
  if (has(t.mbz?.recording)) f.push(frame('UFID', Buffer.concat([latin1('http://musicbrainz.org'), Z, latin1(t.mbz.recording)])));
  for (const [k, desc] of Object.entries(MBZ_TXXX)) if (has(t.mbz?.[k])) f.push(txxx(desc, t.mbz[k]));
  if (has(t.lyrics?.text)) f.push(withLanguage('USLT', t.lyrics.lang ?? 'eng', '', t.lyrics.text));
  if (cover) f.push(frame('APIC', Buffer.concat([UTF8, latin1('image/jpeg'), Z, Buffer.from([3]), Z, cover])));
  const body = Buffer.concat(f);
  return Buffer.concat([latin1('ID3'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]);
}

// ---------------------------------------------------------------- iTunes atoms (MP4)

/** [atom, values, kind] for an MP4 ilst, kind being 'text', 'trkn', 'disk', 'bool', 'int16' or 'jpeg'; freeform
 *  atoms are named '----:com.apple.iTunes:NAME'. */
export function mp4Items(t, cover) {
  const out = [], has = v => v !== undefined && v !== null && v !== '';
  const add = (atom, v, kind = 'text') => { if (has(v) && !(Array.isArray(v) && !v.length)) out.push([atom, [v].flat(), kind]); };
  const free = name => `----:com.apple.iTunes:${name}`;
  add('©nam', t.title);
  add('©ART', t.artist);
  add(free('ARTISTS'), t.artists);
  add('aART', t.albumArtist);
  add('©alb', t.album);
  if (t.track) out.push(['trkn', [t.track], 'trkn']);
  if (t.disc) out.push(['disk', [t.disc], 'disk']);
  add(free('DISCSUBTITLE'), t.discSubtitle);
  add('©day', t.date);
  add(free('ORIGINALDATE'), t.originalDate);
  add('©gen', t.genres);
  if (t.compilation) out.push(['cpil', [1], 'bool']);
  add('soar', t.sort?.artist);
  add('soaa', t.sort?.albumArtist);
  add('soal', t.sort?.album);
  add('sonm', t.sort?.title);
  add('©cmt', t.comment);
  if (has(t.bpm)) out.push(['tmpo', [Number(t.bpm)], 'int16']);
  for (const [k, name] of Object.entries(RG)) add(free(name), t.replayGain?.[k]);
  for (const [k, name] of Object.entries(MBZ_MP4)) add(free(name), t.mbz?.[k]);
  add('©lyr', t.lyrics?.text);
  if (cover) out.push(['covr', [cover], 'jpeg']);
  return out;
}
