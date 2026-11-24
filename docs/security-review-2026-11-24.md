# Security review, 2026-11-24

An adversarial review of the Rust server (`server/`) at `6094387`, as `docs/security-review-brief.md` asks: the
gateway, the Subsonic sign-in, `/auth`, and Sonus Connect version 2. Everything was run against servers started on
this machine on copies of the golden database (`tools/fixtures`); nothing touched the production server, whose
configuration was not looked at.

**Result.** No way was found for an outsider to sign in, or to read another user's data, on a server reached
directly. Six weaknesses were proven, the worst of them only when the server is told it sits behind a reverse proxy,
which is how it will be deployed. Each has a failing test in `tools/contract/security/findings.test.mjs`
(`node --test tools/contract/security/findings.test.mjs`: all 6 failed on `6094387`).

**Fixed since**, at the owner's request, in the commit after this report on the same branch; all 6 tests pass, with
the server's own tests, the contract suite through the gateway (129) and the differential runner (169 the same).
The findings below describe the code as reviewed.

| | Fix | Left open |
|---|---|---|
| F1 | No header signs anyone in unless `ExtAuth.UserHeader` names one (Navidrome's default `Remote-User` is gone; empty and `none` mean none). `Remote-User` from a client is never passed on to Navidrome | A deployment that does name a header still depends on its proxy overwriting it |
| F2 | From a trusted proxy only `X-Forwarded-For` is believed, never `True-Client-IP` or `X-Real-IP` | A proxy that sends only `X-Real-IP` leaves every client with the proxy's address: it must send `X-Forwarded-For` |
| F3 | 10 wrong verification codes for an account in an hour, from anywhere, and no code is looked at for the rest of the hour (429). Kept in memory: a restart forgets | Password guessing is still limited by address only; someone who has the password can keep the owner's second step refused. Nobody is told |
| F4 | 5 waiting sign-ins per address (the address's oldest gives way), 2000 in all (the oldest unapproved gives way): a new sign-in always gets a place | With several hundred addresses the list can still be turned over faster than a user approves |
| F5 | A form post's body has 30 s to arrive, a request under `/auth` 10 s | Still up to 10 MiB per connection for those 30 s; no cap on connections per address; bodies streamed on to Navidrome are not timed |
| F6 | Turning two-step verification on ends the account's sessions; the one that did it goes on with the token the confirmation answers. Turning it off or an admin's reset ends none (those sessions were opened with a code) | Making an app password still asks for no code; the old web UI's handling of the new token after confirming was not checked in a browser |

Two behaviours differ from the frozen Navidrome on purpose (F1's default, F6's ended sessions); the differential
test that assumed the second was changed to go on with the new token.

## Findings

| | Finding | Severity | Needs |
|---|---|---|---|
| F1 | Behind a trusted proxy, a `Remote-User` header signs anyone in as anyone; environment settings cannot turn it off | High | `ExtAuth.TrustedSources` set, and a proxy that does not remove the header |
| F2 | Behind a trusted proxy, `True-Client-IP` chosen by the client resets every sign-in limit | Medium | as F1, and a proxy that does not overwrite the header |
| F3 | No limit per account: authenticator codes can be guessed from many addresses | Medium | the account's password, many addresses (IPv6) |
| F4 | Anonymous clients can fill the browser sign-in waiting list, so no app can sign in | Medium (availability) | nothing |
| F5 | Unfinished request bodies are held without a time limit: 10 MiB each, before any credential check | Medium (availability) | nothing |
| F6 | Sessions made before two-step verification was turned on keep working, and can mint app passwords | Low to medium | a session from before |

### F1. `Remote-User` behind a trusted proxy

With `ND_EXTAUTH_TRUSTEDSOURCES=127.0.0.1/32`, one request carrying `Remote-User: admin` and no password answered
`/rest/getUsers`, got the web page with an admin session in it, read `/api/user`, and made an app password
(`POST /auth/app-passwords`: a permanent key that also skips two-step verification).

This is Navidrome's external authentication working as designed; the weakness is what it takes to not have it.
Telling the server which address is its proxy is needed for the limits to count per client (see "Deployment"
below), and the same setting turns sign-in by header on, with the header defaulting to `Remote-User`. A proxy passes
that header on from the client unless told to remove it. `ND_EXTAUTH_USERHEADER=""` does not turn it off: an empty
environment value reads as not set (`config.rs`, `get_renamed`; Navidrome's viper does the same), so a server
configured by environment alone, as a container template is, cannot separate the two. Only a configuration file can
(`ExtAuth.UserHeader = ""`).

Recommended: sign-in by header off unless asked for by name (a setting of its own, or no default for the header in
the Rust server), and an explicit off value that works from the environment. The Rust server already refuses to
start on other unsafe settings; it could say at start-up, at warn level, that header sign-in is on and from which
addresses.

### F2. The client's address behind a trusted proxy

From a trusted peer the client's address is `True-Client-IP`, else `X-Real-IP`, else `X-Forwarded-For` walked from
the right (`trust.rs`, as chi does). The walk is sound: 12 tries with a changing first `X-Forwarded-For` entry and
the proxy's entry fixed were limited after 5. But a proxy configured the usual way
(`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`) passes `True-Client-IP` through untouched: 40 wrong
codes from one client, a different `True-Client-IP` each, were all tried. Every limit keyed by address (web sign-in,
Subsonic sign-in, device sign-in) falls with it, and so does what the log says about who did it.

Recommended: name the one header to believe in the configuration (default `X-Forwarded-For` only), not three in an
order the operator cannot see.

### F3. No limit per account

Web sign-in is limited to 5 requests per 20 s per address (per /64 for IPv6); Subsonic sign-in per address and user
name. Nothing counts per account. 200 wrong codes for one account from 40 addresses were all tried in 0.7 s, and the
right code then signed in from another address. With the password known, 3 of 1 000 000 codes are right at any time
(±1 step), so about 330 000 tries are expected; an attacker with a routed IPv6 /48 has 65 536 /64s and is limited
only by the server's speed. The public name has an AAAA record. The same holds for guessing a weak password over
Subsonic (100 guesses from 20 addresses, all tried).

Recommended: count failed second steps per account whatever the address (for example 10 per 15 minutes, then a
delay that grows), and tell the owner. A hard lock is itself a way to lock the owner out, so a delay rather than a
lock; app passwords and API keys (random, long) need no such limit.

### F4. The browser sign-in waiting list

`POST /auth/device/start` needs no credentials; the server keeps at most 200 pending sign-ins, 10 minutes each
(`auth/device.rs`). 200 starts from 40 addresses filled it, and a real app was then answered
`429 Too many sign-ins waiting`. One address can keep it full (15 starts a minute against 20 expiring), a handful
comfortably. The Windows and Android apps sign in this way only.

Recommended: a small quota per address inside the 200 (for example 5 pending), and when full drop the oldest
unapproved entry rather than refuse the newest.

### F5. Bodies that never arrive

A form post to `/rest/*` is read whole, up to 10 MiB, before the credentials are looked at (`subsonic/mod.rs`,
`params.rs`), and nothing limits how long a body may take. 30 connections that each sent 10 MiB less one kilobyte
took the server from 18 to 324 MiB and held it there until they were closed (41 s observed, no sign of a limit).
A few hundred such connections exhaust the container's memory. `/auth` bodies are small (8 KiB) but wait the same
way, holding connections.

Recommended: a time limit on reading headers and bodies (hyper's `header_read_timeout`, and a timeout around the
body collect), a much smaller limit for the form of a sign-in (the credentials fit in a few kilobytes; a larger form
can be passed on unread once signed in), and a cap on connections per address.

### F6. Sessions from before two-step verification

Under `ND_SONUS_TWOFACTOR=optional`, a session opened with the password alone still read the library after the
owner turned two-step verification on, and made an app password without being asked for a code. Sessions end only
when the password changes (`token_epoch`), and Navidrome renews a live session as it is used. So the natural
reaction to "someone has my password" (turn two-step verification on) does not remove the someone. The same goes for
an admin resetting a user's verification.

Recommended: turning verification on, off or resetting it ends the account's other sessions (raise the epoch, hand
the acting session a new token), and making an app password asks for a code when the account has verification.

## Weaknesses by design, for a decision

- **First enrolment needs only the password.** Under `required`, whoever first signs in to an account that has not
  enrolled yet sets up the authenticator, gets the recovery codes, and the owner is then asked for a code only the
  attacker has (proven; no test, since the fix is a policy choice). For accounts the admin creates, a one-time
  enrolment code handed over with the password would close it.
- **Approving a device needs a session, not a code.** Someone signed in who is talked into opening an attacker's
  approval link gives the attacker a permanent key. Showing the requesting app, device and address on the approval
  page, and asking for a code there, would raise the bar.
- **An admin resets a user's verification without a code** (flagged by the authors): an admin session is then worth
  every account. Covered by F6's second recommendation if resets ask for the admin's code.
- **Failed attempts from an address lock that address out for a user name even with the right password** (proven: 5
  wrong passwords, then the right one answered error 40). Harmless per client; behind an unannounced proxy or a
  shared address it lets anyone lock anyone out. See below.

**Decided since** (the owner, 2026-11-25), and built in the Rust server and both web UIs (`server/README.md`,
"Codes a session alone does not replace"; tests in `tools/contract/security/hardening.test.mjs`): a first set-up
under `required` takes a one-time enrolment code an admin made; allowing an app, making an app password and an
admin's reset each take a verification code of the acting account, and the approval page shows the address that
asked. The lockout by address after failed sign-ins stays as it is.

## Deployment: the reverse proxy

The server will run behind openresty, which makes one of two things true, and both were proven here:

- **The server is not told about the proxy** (no `ExtAuth.TrustedSources`): every client has the proxy's address.
  The whole internet shares 5 web sign-in requests per 20 s, and anyone can keep any user name locked out of
  Subsonic sign-in with 5 wrong passwords per window. Forged headers do nothing.
- **The server is told** (`TrustedSources=<proxy>/32`): limits count per client, and F1 and F2 open unless the proxy
  clears `Remote-User`, `True-Client-IP` and `X-Real-IP` on the way in.

Until F1 and F2 are fixed, the safe arrangement is the second with the proxy setting all three itself:
`proxy_set_header Remote-User "";`, `proxy_set_header True-Client-IP "";`, `proxy_set_header X-Real-IP $remote_addr;`
and `ExtAuth.UserHeader = ""` in a configuration file. Which of the two the production server is in today was not
checked (it needs the owner's approval to look).

## What held

Tried and refused, on a server reached directly:

- **Naming yourself a user.** `Remote-User` and case and underscore variants, on `/rest`, `/api`, `/app`, `/auth`:
  refused; the page signs nobody in. The header the gateway uses towards Navidrome is random per start and is in no
  log or response. Client-sent `X-Forwarded-For`, `X-Real-IP`, `True-Client-IP` are not believed.
- **Request smuggling and path differences.** `Content-Length` with `Transfer-Encoding` in both orders, two lengths,
  bad or folded headers, bare line feeds, `CONNECT`, absolute URIs; `/rest/ping/`, `//rest/ping`, `/REST/ping`,
  encoded slashes and dots, `;` parameters: one response each, never a second request, never signed in by a path the
  gateway did not check.
- **Mixed credentials.** Two `u`, form against query, one user's name with another's key or token: errors, never the
  other user.
- **Tokens.** `alg: none`, an empty key, a guessed key: refused everywhere. The two-step set-up token is good for
  set-up only: refused on `/api`, the signed-in `/auth` routes, app passwords, `jwt=`, as a cookie, for approving a
  device, for opening Connect, and for enrolling again once enrolled.
- **Skipping the second step.** A password without a code gets no session and Subsonic error 40; a code that is not
  a string is refused; Connect does not open.
- **Connect.** No credentials, wrong ones, a set-up token, a password without a code: not opened. Two users never
  hear of each other's devices or queue; saying hello with another user's device id touches nothing of theirs.
  Messages over 1 MiB close the link (1009); 60 links that never say hello: 8 kept waiting, 52 closed (1013).
- **Logs.** No password, token or key in the gateway's or Navidrome's log at debug level; a user name with a line
  break does not start a line of its own.

## Not tested

- The production server and its proxy configuration; TLS; the container image as it runs on Unraid.
- Timing differences between a user name that exists and one that does not (a few extra queries for one that does;
  not measured, and of little use to an attacker against three accounts).
- Large Connect queues from a signed-in user (limits exist: 10 000 and 1 000 entries, 32 devices; not stressed), and
  credentials being checked only when a Connect link opens (flagged by the authors: a link outlives a password
  change until it drops).
- Navidrome's own routes behind the gateway (`/api`, `/share`, the old web UI) beyond who is signed in: they are the
  frozen fork's code, to be replaced in phases 3 and 4.
- The Windows, Android and web clients.
