// The demo server's catalogue: fictitious artists, albums and songs (titles, formats, play counts, likes), with
// generated abstract covers. Nothing here is real music metadata.

// ---------------------------------------------------------------- deterministic randomness
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const hash = str => { let h = 2166136261; for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// ---------------------------------------------------------------- the library (fictitious)
const FORMATS = {
  flac16: { codec: 'FLAC', sampleRate: 44100, bitDepth: 16, kbps: [780, 1120], ext: 'flac' },
  flac2496: { codec: 'FLAC', sampleRate: 96000, bitDepth: 24, kbps: [2600, 3300], ext: 'flac' },
  flac24192: { codec: 'FLAC', sampleRate: 192000, bitDepth: 24, kbps: [4900, 6100], ext: 'flac' },
  alac2448: { codec: 'ALAC', sampleRate: 48000, bitDepth: 24, kbps: [1700, 2300], ext: 'm4a' },
  mp3: { codec: 'MP3', sampleRate: 44100, bitDepth: 0, kbps: [320, 320], ext: 'mp3' },
  aac: { codec: 'AAC', sampleRate: 44100, bitDepth: 0, kbps: [256, 256], ext: 'm4a' },
  dsd64: { codec: 'DSD64', sampleRate: 2822400, bitDepth: 1, kbps: [5645, 5645], ext: 'dsf' },
  opus: { codec: 'Opus', sampleRate: 48000, bitDepth: 0, kbps: [160, 160], ext: 'opus' },
};
const TITLES = {
  zh: ['海边的风', '夜行列车', '旧信', '雾里看花', '晚安，城市', '第七个夏天', '蓝色信号', '无人知晓', '慢一点', '回声', '路灯下', '星期天的雨', '山那边', '月台', '纸飞机', '玻璃心', '白日梦', '如果明天', '南方', '长街', '微光', '空房间', '一万次', '渡口', '远方来信', '晴天以后', '灯塔', '停电的夜', '候鸟', '漫游', '霓虹', '潮汐'],
  ja: ['夜明けのバス', '青い鳥', '雨のち晴れ', '帰り道', '夏の終わり', '星屑ライン', 'さよならの前に', '海が見える街', 'ひかり', '風の音', '午前零時', 'ガラスの靴', '坂道', '透明', '花火', 'ゆめのあと', '水平線'],
  en: ['Harbour Lights', 'Paper Moon', 'Slow Static', 'After Hours', 'Northbound', 'Glass House', 'Signal Fires', 'Quiet Rooms', 'Low Tide', 'Satellite', 'Golden Hour', 'Echo Park', 'Small Hours', 'Undertow', 'Blue Hour', 'Night Drive', 'Afterglow', 'Driftwood', 'Silver Line', 'Open Water', 'Long Way Home', 'Paper Planes', 'Static Bloom', 'Wildfire', 'Halcyon', 'Late Bloomer', 'Weightless', 'Orbit', 'Tidal'],
  classical: ['I. Allegro moderato', 'II. Adagio cantabile', 'III. Scherzo: Presto', 'IV. Finale: Allegro con fuoco', 'Nocturne No. 1 in B-flat minor', 'Nocturne No. 2 in E-flat major', 'Nocturne No. 3 in B major', 'Nocturne No. 4 in F major', 'Nocturne No. 5 in F-sharp major', 'Nocturne No. 6 in G minor', 'Nocturne No. 7 in C-sharp minor', 'Nocturne No. 8 in D-flat major'],
};
const LYRIC = {
  zh: ['风把夜晚吹得很轻', '我在月台等一班不会来的车', '城市的灯一盏一盏熄灭', '你说明天会更好', '雨落在旧信的折痕里', '我们都在慢慢长大', '把心事交给潮汐', '海边的风还记得你', '路灯下影子变长', '如果时间可以停一停', '远方的信号很微弱', '我还在原地', '一万次回头', '晴天以后会是什么', '候鸟飞过空房间'],
  ja: ['夜明けのバスに揺られて', '君の声がまだ聞こえる', '雨のち晴れの帰り道', '星屑を数えながら', 'さよならの前に笑って', '透明な風が吹いて', '午前零時の約束', '花火が消えたあとで', '水平線の向こうへ', 'ゆめのあとを歩いてる'],
  en: ['Harbour lights are fading slow', 'I kept the static on the radio', 'Paper moons above the bay', 'We drove all night to nowhere', 'Golden hour on an empty street', 'Hold on to the undertow', 'Every signal fire burns out', 'Small hours, quiet rooms', 'Open water, open heart', 'Take the long way home tonight', 'Afterglow is all we have', 'Weightless in the blue hour'],
};
const INSTRUMENTAL = new Set(['Post-Rock', 'Classical', 'Ambient', 'Soundtrack', 'Jazz']);

// [name, genre, title language, [title, type, year, tracks, format, label]]
const CATALOGUE = [
  ['林间信号', 'Post-Rock', 'zh', [['雾中山脉', 'album', 2019, 8, 'flac2496', '回声唱片'], ['信号塔', 'album', 2022, 9, 'flac16', '回声唱片'], ['微光', 'ep', 2024, 4, 'flac2496', '回声唱片']]],
  ['夏夜电台', 'City Pop', 'zh', [['霓虹航线', 'album', 2018, 10, 'flac16', '晚风音乐'], ['晚安，城市', 'album', 2021, 11, 'flac16', '晚风音乐'], ['第七个夏天', 'single', 2025, 2, 'flac16', '晚风音乐']]],
  ['陈默', 'Folk', 'zh', [['旧信', 'album', 2016, 10, 'mp3', '独立发行'], ['南方', 'album', 2020, 9, 'flac16', '山谷唱片']]],
  ['白噪音工厂', 'Electronic', 'zh', [['夜行列车', 'album', 2021, 9, 'alac2448', '数字森林'], ['潮汐', 'ep', 2023, 5, 'alac2448', '数字森林']]],
  ['南方旧梦', 'Indie', 'zh', [['长街', 'album', 2017, 10, 'flac16', '旧梦工作室'], ['渡口', 'album', 2024, 9, 'flac2496', '旧梦工作室']]],
  ['月影ノート', 'J-Pop', 'ja', [['星屑ライン', 'album', 2020, 11, 'flac16', 'Tsukikage Records'], ['夏の終わり', 'album', 2023, 10, 'flac2496', 'Tsukikage Records']]],
  ['青い車', 'Rock', 'ja', [['透明', 'album', 2015, 10, 'mp3', 'Aoi Label'], ['午前零時', 'album', 2022, 9, 'flac16', 'Aoi Label']]],
  ['坂道ピアノ', 'Ambient', 'ja', [['雨のち晴れ', 'album', 2021, 9, 'flac2496', 'Slope Music'], ['ひかり', 'album', 2025, 8, 'flac24192', 'Slope Music']]],
  ['The Harbour Lights', 'Indie', 'en', [['Low Tide', 'album', 2014, 10, 'flac16', 'Pier Records'], ['Signal Fires', 'album', 2019, 11, 'flac16', 'Pier Records']]],
  ['Paper Moons', 'Dream Pop', 'en', [['Afterglow', 'album', 2018, 10, 'flac16', 'Lantern'], ['Weightless', 'album', 2024, 9, 'flac2496', 'Lantern']]],
  ['Slow Static', 'Shoegaze', 'en', [['Undertow', 'album', 2016, 9, 'flac16', 'Fuzz Union'], ['Open Water', 'album', 2021, 10, 'flac16', 'Fuzz Union']]],
  ['Northbound Ensemble', 'Soundtrack', 'en', [['The Long Way Home (Original Score)', 'album', 2020, 12, 'alac2448', 'Meridian Scores']]],
  ['Glass House Quartet', 'Jazz', 'en', [['Blue Hour Sessions', 'album', 2017, 8, 'flac2496', 'Late Set'], ['Small Hours', 'album', 2023, 7, 'dsd64', 'Late Set']]],
  ['Mira Voss', 'Electronic', 'en', [['Satellite', 'single', 2022, 2, 'aac', 'Orbit Audio'], ['Orbit', 'album', 2024, 10, 'flac16', 'Orbit Audio']]],
  ['Amber Field', 'Folk', 'en', [['Driftwood', 'album', 2019, 10, 'aac', 'Meadow']]],
  ['Aurelia Chamber Orchestra', 'Classical', 'classical', [['Symphony No. 4 in E minor', 'album', 2015, 4, 'flac2496', 'Aurelia Classics'], ['Nocturnes', 'album', 2019, 12, 'flac24192', 'Aurelia Classics']]],
  ['Kite & Compass', 'Lo-fi', 'en', [['Paper Planes', 'album', 2023, 11, 'mp3', 'Bedroom Tapes'], ['Late Bloomer', 'ep', 2025, 5, 'opus', 'Bedroom Tapes']]],
];

// ---------------------------------------------------------------- artwork (generated: abstract covers, one per album)
function hsl(h, s, l) { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return `#${[f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`; }
function cover(seed) {
  const r = rng(seed), h = Math.floor(r() * 360), h2 = (h + 30 + Math.floor(r() * 150)) % 360;
  const base = hsl(h, 45 + r() * 25, 30 + r() * 16), deep = hsl(h, 50, 12 + r() * 8), hi = hsl(h2, 70, 58 + r() * 14), soft = hsl(h2, 40, 80);
  const style = Math.floor(r() * 6);
  let art = '';
  if (style === 0) for (let i = 6; i > 0; i--) art += `<circle cx="${150 + (r() - 0.5) * 30}" cy="${150 + (r() - 0.5) * 30}" r="${i * 22}" fill="none" stroke="${i % 2 ? hi : soft}" stroke-opacity="${0.25 + i * 0.08}" stroke-width="${3 + r() * 6}"/>`;
  else if (style === 1) { for (let i = -6; i < 12; i++) art += `<rect x="${i * 34}" y="-60" width="${10 + r() * 12}" height="420" fill="${i % 3 ? hi : soft}" fill-opacity="${0.18 + r() * 0.5}" transform="rotate(32 150 150)"/>`; }
  else if (style === 2) art = `<circle cx="${110 + r() * 80}" cy="${100 + r() * 50}" r="${50 + r() * 30}" fill="${hi}"/><rect x="0" y="${180 + r() * 30}" width="300" height="140" fill="${deep}" fill-opacity=".85"/><rect x="0" y="${200 + r() * 30}" width="300" height="4" fill="${soft}" fill-opacity=".6"/>`;
  else if (style === 3) { for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) if (r() < 0.55) art += `<rect x="${24 + x * 52}" y="${24 + y * 52}" width="44" height="44" rx="${r() < 0.3 ? 22 : 3}" fill="${r() < 0.5 ? hi : soft}" fill-opacity="${0.3 + r() * 0.7}"/>`; }
  else if (style === 4) { for (let i = 0; i < 9; i++) { const y = 40 + i * 28, a = 10 + r() * 30; art += `<path d="M-10 ${y} C 70 ${y - a}, 130 ${y + a}, 200 ${y} S 290 ${y - a}, 320 ${y}" fill="none" stroke="${i % 2 ? hi : soft}" stroke-opacity="${0.3 + r() * 0.6}" stroke-width="${2 + r() * 5}"/>`; } }
  else art = `<path d="M0 300 L${80 + r() * 40} ${110 + r() * 60} L${170 + r() * 30} ${190 + r() * 30} L${220 + r() * 30} ${90 + r() * 50} L300 300Z" fill="${deep}" fill-opacity=".9"/><path d="M0 300 L${60 + r() * 50} ${170 + r() * 40} L300 300Z" fill="${hi}" fill-opacity=".55"/><circle cx="${220 + r() * 40}" cy="${60 + r() * 30}" r="${14 + r() * 10}" fill="${soft}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${base}"/><stop offset="1" stop-color="${deep}"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>${art}<rect width="300" height="300" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="2"/></svg>`;
  return { url: `data:image/svg+xml,${encodeURIComponent(svg)}`, color: base };
}

export function buildLibrary() {
  const r = rng(20261006);
  const tracks = [], albums = [], artists = [];
  const now = Date.UTC(2026, 9, 6);
  CATALOGUE.forEach(([name, genre, lang, list], ai) => {
    const artist = { id: `ar${ai}`, name, genre, albumIds: [], color: cover(hash(name)).color };
    artists.push(artist);
    for (const [title, type, year, count, fmt, label] of list) {
      const id = `al${albums.length}`, art = cover(hash(`${name}/${title}`)), f = FORMATS[fmt];
      const album = { id, title, artist: name, artistId: artist.id, year, genre, type, label, format: fmt, trackIds: [], color: art.color, _art: art.url };
      const pool = [...TITLES[lang]].sort(() => r() - 0.5);
      const discs = count >= 12 && lang !== 'classical' ? 2 : 1, added = now - Math.floor((2026 - year) * 0.35 * 365 + r() * 120) * 864e5;
      for (let n = 0; n < count; n++) {
        const disc = discs === 2 && n >= Math.ceil(count / 2) ? 2 : 1, number = disc === 2 ? n - Math.ceil(count / 2) + 1 : n + 1;
        const t = type === 'single' && n === 0 ? title : lang === 'classical' && title.startsWith('Symphony') ? TITLES.classical[n] : lang === 'classical' ? (TITLES.classical[4 + n] ?? `Nocturne No. ${n + 1}`) : pool[n % pool.length];
        const duration = genre === 'Classical' ? 280 + Math.floor(r() * 420) : genre === 'Post-Rock' ? 300 + Math.floor(r() * 280) : 150 + Math.floor(r() * 150);
        const kbps = Math.round(f.kbps[0] + r() * (f.kbps[1] - f.kbps[0])), plays = Math.floor(r() ** 3 * 60);
        const tid = `t${tracks.length}`;
        tracks.push({
          id: tid, title: type === 'single' && n === 1 ? `${title} (Instrumental)` : t, artist: name, artistId: artist.id, album: title, albumId: id, number, disc, duration, genre, year,
          codec: f.codec, bitrate: kbps, sampleRate: f.sampleRate, bitDepth: f.bitDepth, channels: 2, size: Math.round((kbps * 1000 / 8) * duration),
          path: `D:\\Music\\${name}\\${year} - ${title}\\${String(number).padStart(2, '0')}. ${t.replace(/[:?]/g, '')}.${f.ext}`,
          added, playCount: plays, lastPlayed: plays ? now - Math.floor(r() * 200) * 864e5 - Math.floor(r() * 864e5) : null, liked: r() < 0.14,
          replayGain: f.codec === 'Opus' ? { track: null, album: null } : { track: -Math.round((4 + r() * 6) * 100) / 100, album: -Math.round((5 + r() * 4) * 100) / 100 },
          lang, instrumental: INSTRUMENTAL.has(genre) || (type === 'single' && n === 1),
        });
        album.trackIds.push(tid);
      }
      albums.push(album); artist.albumIds.push(id);
    }
  });
  // a missing file, and one album without artwork (the "no artwork" state)
  tracks[57].unavailable = true; tracks[57].reason = '找不到文件：可能已被移动或删除';
  albums[albums.length - 1]._art = null;
  return { tracks, albums, artists };
}

export { rng, hash, LYRIC };
