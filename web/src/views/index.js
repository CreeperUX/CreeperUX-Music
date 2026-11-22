import { homeView } from './home.js';
import { albumView } from './album.js';
import { artistView } from './artist.js';
import { playlistView } from './playlist.js';
import { searchView } from './search.js';
import { lyricsView } from './lyrics.js';
import { shelfView, genreView } from './collection.js';
import { settingsView } from './settings.js';

export const VIEWS = { home: homeView, album: albumView, artist: artistView, playlist: playlistView, search: searchView, lyrics: lyricsView, shelf: shelfView, genre: genreView, settings: settingsView };

/** '#/album/al3' → { name: 'album', id: 'al3' }; '#/search/雨' → { name: 'search', id: '雨' }. */
export function parseRoute(hash) {
  const [name = 'home', ...rest] = String(hash || '').replace(/^#\/?/, '').split('/');
  const id = rest.length ? decodeURIComponent(rest.join('/')) : '';
  return { name: VIEWS[name] ? name : 'home', id };
}
