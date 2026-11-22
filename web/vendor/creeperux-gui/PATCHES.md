# Local patches to the vendored CreeperUX UI Kit

`vendor/creeperux-gui` is a copy of the kit (see `SOURCE`). These changes were made to the copy for foobar2k and are
not in the kit yet. `npm run sync-kit` overwrites the copy: re-apply them after a sync until the kit carries the fixes
(then delete the entry here). Each patched line is marked `foobar2k patch Pn`.

## P1 — workspace: stop at the first focusable when deciding a region's tab stop

- Files: `overlay.js` (adds `hasFocusableIn`), `ui/workspace.js` (`scrollStops` uses it).
- Why: `scrollStops` runs after every DOM change in the main region and called `focusableIn(main).length`, which
  measures every focusable candidate with `getClientRects()`. In a 590-song playlist (about 3000 buttons and links, rows
  laid out lazily with `content-visibility`) that forced layout of the whole list: about 750 ms of main-thread time on
  each track change, and most of the 700 ms it took to open the playlist.
- Effect (Edge, `node tools/perf-views.mjs --scale=8`): track change with the playlist open 638 → 91 ms; opening it
  708 → 192 ms. Behaviour is the same (the question is only "is there any focusable at all").

## P2 — table: a rowState-only update does not rebuild the rows

- File: `ui/table.js` (`update()` returns after `applyState` when `rowState` is the only change).
- Why: `update({ rowState })` (the media list sends it when the playing track changes) marked the rows with
  `applyState` and then still ran `render()`, which replaces every row of a non-virtual table. That cost about 150 ms of
  style and layout per track change in a 590-song list, and — with the focused row replaced — made Chromium reset the
  main area's scroll position (the "jumps to the top" bug; foobar2k also guards against it in `src/views/common.js`).
- Effect: with P1, track change 177 → about 100 ms.
