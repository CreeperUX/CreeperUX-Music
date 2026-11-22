# @creeperux/gui 2.5.0 — kit/

The shipped package contents. Entry points and usage: [../README.md](../README.md); API reference: the docs site in
`concept/docs/` (generated from these sources); changes: [../CHANGELOG.md](../CHANGELOG.md); migrating from 1.x:
[../docs/MIGRATION_2.md](../docs/MIGRATION_2.md).

| Path | Role |
| --- | --- |
| `ui/` | Package root (`@creeperux/gui`): components, `index.js`, `index.d.ts`, `ui.css` source |
| `plus/` | `@creeperux/gui/plus`: P1 components |
| `media/` | `@creeperux/gui/media` (2.5.0): the player layer; imports only the public root and `/plus` |
| `vue/` | `@creeperux/gui/vue` (2.5.0): a thin Vue 3 wrapper; needs the optional peer `vue` |
| `*.js` | Shared infrastructure: services, motion core, overlay manager, positioning, focus, i18n, formatting, icons |
| `ui.min.js`, `ui.bundle.css`, `plus.min.js`, `plus.bundle.css`, `media.min.js`, `media.bundle.css` | Generated bundles (`npm run build:kit`) |
| `foundation.css`, `tokens.js`, `tokens.json` | Generated from `tokens/tokens.json` |
| `fonts.css`, `fonts/` | Optional fonts and their SIL OFL licences |
