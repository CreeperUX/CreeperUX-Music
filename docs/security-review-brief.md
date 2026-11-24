# Adversarial security review of the Sonus server: brief for the reviewer

You are reviewing the Sonus music server as an attacker would. The owner (not a programmer; write to them in
Simplified Chinese, plainly) runs it at home, reachable from the internet, for a few users. Everything you are to
review was written by other AI sessions in the last days and reviewed by a coordinating session; assume both missed
things. This is authorised defensive review of the owner's own code, on their own computer.

## What it is

- Repository `CreeperUX/Sonus` (this checkout), folder `server/`: a Rust server (about 10,000 lines) that sits in
  front of Navidrome, a Go music server (a frozen fork, 0.64.2, at
  `C:\Users\Creep\Documents\Claude Workspace\navidrome`, branch `creeperux`; its own additions are in its `SONUS.md`).
  Both run in one container; the Rust server listens on the public port and starts Navidrome on `127.0.0.1:4534`.
- Read first: `server/SECURITY.md` (the authors' own account of decisions, trust boundaries and what could go wrong:
  treat every claim in it as a hypothesis to break), `server/README.md`, `docs/protocol/connect.md`,
  `docs/server-roadmap.md` (Chinese; the plan this is part of).
- What the Rust server decides today:
  1. **The gateway** (`src/gateway.rs`, `src/trust.rs`, `src/config*`): who the client is (its IP, forwarding
     headers believed only from trusted proxies), and the one header by which it tells Navidrome which user is
     signed in. Navidrome believes that header from 127.0.0.1.
  2. **Subsonic sign-ins** (`src/subsonic/`): every `/rest/*` credential check (password, `enc:`, token+salt, API
     key, app passwords, the two-step rule, a failed-attempt limiter); the request then goes to Navidrome with the
     credentials removed and the user header set.
  3. **`/auth/*`** (`src/auth/`, `src/jwt.rs`): web sign-in, the first admin, two-step verification (TOTP, recovery
     codes), app passwords, the browser (device-code) sign-in for apps; session JWTs that Navidrome also accepts.
  4. **Sonus Connect v2** (`src/connect/`): a WebSocket at `rest/connect?protocol=2`, one playback session per
     user, stored in the database.
  5. **The database** (`src/db.rs`, `src/secrets.rs`): Navidrome's SQLite file, opened beside Navidrome; passwords
     there are AES-GCM encrypted, not hashed (Subsonic's token scheme needs the plaintext).

## What to try to do

Rank by what an attacker on the internet gains. In rough order of what matters most to the owner:

1. **Become a user without their credentials, or become another user.** The user header is the crown jewel: find any
   request (any method, path, encoding, HTTP version, header casing or duplication, request smuggling between the
   gateway's parser and Go's, an upgrade, a malformed query, `BaseURL` prefixes, paths Navidrome's router matches
   and `routes.rs` does not) where a client-controlled value reaches Navidrome as the trusted user header or as a
   forwarded address, or where Navidrome still checks credentials itself with different rules.
2. **Bypass two-step verification**, or turn a setup token, an app password, an API key, a device code or a recovery
   code into more than it should grant; replay or forge a session token (algorithm confusion, `aud`, `ep`, expiry,
   the secret's handling); race the first-admin creation; fix or steal a device sign-in (a victim approving the
   attacker's code, code guessing, the pending table's limits).
3. **Read or change another user's data** through Connect v2 (another user's session, devices, library visibility)
   or through anything the Rust server answers itself.
4. **Guess credentials faster than intended**: limiter bypasses (address spoofing, per-route gaps, the WebSocket,
   resets), timing differences, user enumeration.
5. **Take the server down cheaply** from outside: unbounded memory or connections, slow requests, the database
   lock, large bodies or frames, the supervisor (what happens when Navidrome dies or hangs).
6. **Leak secrets**: credentials or tokens in logs, error messages, redirects, the database file's new tables.
7. **Damage Navidrome's database** (the Rust server writes to it): anything that breaks Navidrome's own start-up
   or its full-text search triggers.

The authors themselves flagged these as open (confirm, weigh, recommend):
- authenticator codes are rate-limited per address only, with no per-user lockout;
- an admin's reset of someone's two-step verification asks for no code;
- `createAdmin` accepts empty names and passwords (as Navidrome does);
- Connect checks credentials when a connection opens and not again (a revoked key keeps its open connection);
- one start-up probe signs in to Navidrome as nobody, on purpose (see SECURITY.md).

## How to work

- Read the code; then **prove** what you find. A finding counts when a test or a script shows it against a running
  server, not when the code "looks" exploitable. Say clearly which findings are proven and which are suspicions.
- Running things locally, all on 127.0.0.1 with throwaway data:
  - `cd server && cargo test` (192 tests; they show how to drive everything in-process);
  - `node tools/fixtures/build.mjs` once, then `node tools/contract/run.mjs --through-gateway` runs the black-box
    suite against the Rust server in front of the real frozen Navidrome on a generated library with test users
    (admin, a plain user, a two-step user with an app password, an API key); `tools/contract/README.md` and
    `tools/fixtures/README.md` explain how to start such a server yourself and where its throwaway credentials are.
  - An x64 Navidrome build is found by those tools already; Go, if you need to read or build the fork, is at
    `C:\Users\Creep\sdk\go1.27.4`.
- **Never** connect to the owner's production server (CreeperUX-S-D, `music.creeperux.com`, 10.80.10.40) or to any
  machine but this one. Never touch the owner's own Sonus app, its data or its saved sign-in. No downloads or
  installs without asking the owner. Do not print credentials, not even test ones.
- Do not fix anything in `main`. Work on a branch; for each proven finding add a failing test that demonstrates it
  (in `server/tests/` or `tools/contract/`), so the fix can be checked against your test. Fixes themselves are for
  the sessions that own the code, unless a fix is a few obvious lines: then put it in a separate commit.

## What to hand back

A report at `docs/security-review-<date>.md` on your branch (English, for the engineers), opened as a pull request to
`main` (never merged by you), and a summary to the owner in Chinese: for each finding, what an attacker could do in
plain words, how sure you are (proven with a test / likely / theoretical), how bad (critical, high, medium, low),
and what should change. Then what you tried that held, so the owner knows what was actually tested, and what you
could not test. If you find nothing serious, say so plainly and say how hard you looked.
