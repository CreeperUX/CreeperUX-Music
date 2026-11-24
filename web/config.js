// Deployment settings for the Sonus web client. This file is the only one a host needs to change: everything else is a
// static bundle that can be served from any path.
//
// server: where the music server is.
//   ''             the sign-in page asks for the address (the client and the server live in different places);
//   'same-origin'  the server that serves this page, at the path in `base` (the Rust server serving the client itself);
//   'https://…'    a fixed server: the sign-in page does not ask.
// base: the server's base path when it is not at the root of its origin (Navidrome's BaseURL), e.g. '/music'. Used with
//   'same-origin' only; an address typed or given in `server` carries its own path.
window.SONUS_CONFIG = { server: '', base: '' };
