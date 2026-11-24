import { homeView } from './home.js';
import { albumView } from './album.js';
import { artistView } from './artist.js';
import { playlistView } from './playlist.js';
import { searchView } from './search.js';
import { lyricsView } from './lyrics.js';
import { shelfView, genreView } from './collection.js';
import { settingsView } from './settings.js';
import { libraryView } from './library.js';
import { nowView } from './now.js';
import { accountView } from './account.js';
import { deviceView } from './device.js';

export const VIEWS = { home: homeView, album: albumView, artist: artistView, playlist: playlistView, search: searchView, lyrics: lyricsView, shelf: shelfView, genre: genreView, settings: settingsView,
  library: libraryView, now: nowView, account: accountView, device: deviceView };

/** '#/album/al3' → { name: 'album', id: 'al3' }; '#/search/雨' → { name: 'search', id: '雨' }; '#/device?code=AB-CD' → { name: 'device', id: '', query }. */
export function parseRoute(hash) {
  const [path, search = ''] = String(hash || '').replace(/^#\/?/, '').split('?');
  const [name = 'home', ...rest] = path.split('/');
  let id = '';
  try { id = rest.length ? decodeURIComponent(rest.join('/')) : ''; } catch { id = rest.join('/'); } // a stray % in a typed address
  return { name: VIEWS[name] ? name : 'home', id, query: new URLSearchParams(search) };
}
