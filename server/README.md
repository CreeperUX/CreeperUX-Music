# Sonus server

The Sonus music server, in Rust (AGPL-3.0, `LICENSE`). For now a gateway: it listens where Navidrome used to, runs the
CreeperUX fork of Navidrome (frozen at 0.64.2) behind it on a local port, and passes every request through, streamed
both ways, WebSockets included. Parts of the server move here one by one behind the same APIs; the route, with the
decisions behind it, is `docs/server-roadmap.md`.

Status: first skeleton. It builds, its unit tests pass, and it has passed requests, Range streams, form posts, the
Connect WebSocket and the web page through to the demo server. Still to do for phase 0 of the roadmap:
`navidrome.toml` (`ND_CONFIGFILE`) and `BaseURL`, integration tests, the image and its CI.

## Running it

```sh
cargo run                                              # runs `navidrome` (PATH) on 127.0.0.1:4534, listens on :4533
SONUS_NAVIDROME_URL=http://127.0.0.1:4801 cargo run    # in front of a server that runs on its own (the demo server)
```

| Variable | Default | |
|---|---|---|
| `ND_ADDRESS`, `ND_PORT` | `0.0.0.0`, `4533` | where clients connect (Navidrome's own settings: the gateway takes its place) |
| `ND_EXTAUTH_TRUSTEDSOURCES` (`ND_REVERSEPROXYWHITELIST`) | none | the proxies in front whose forwarding headers are believed, as Navidrome reads them (CIDR entries only) |
| `ND_EXTAUTH_USERHEADER` (`ND_REVERSEPROXYUSERHEADER`) | `Remote-User` | passed on only from those proxies |
| `SONUS_NAVIDROME_BIN` | `/app/navidrome`, else `navidrome` | the Navidrome to run |
| `SONUS_NAVIDROME_PORT` | `4534` | its port, on 127.0.0.1 |
| `SONUS_NAVIDROME_URL` | none | an `http://` Navidrome (or demo server) to proxy instead of running one |
| `SONUS_LOG` | `info` | log filter (`debug`: one line per request, the path only: queries carry credentials) |

Navidrome is started with the container's environment, except `ND_ADDRESS=127.0.0.1`, `ND_PORT`, and
`ND_EXTAUTH_TRUSTEDSOURCES=127.0.0.1/32`: the gateway decides who the client is (`src/trust.rs`) and tells Navidrome
alone, with `X-Real-IP`; a client's own forwarding headers, and the user header from anyone but a trusted proxy, never
reach it. When Navidrome stops, the gateway stops too, so the container restarts as it did.

## Code

- `src/config.rs`: settings from the environment.
- `src/trust.rs`: who the client is (Navidrome's rules, reproduced).
- `src/gateway.rs`: the proxy.
- `src/supervisor.rs`: runs Navidrome.
- `src/main.rs`: puts them together; stops on SIGTERM / Ctrl+C.

`cargo test` runs the tests.
