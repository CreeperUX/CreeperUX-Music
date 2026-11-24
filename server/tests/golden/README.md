# Golden values from Go

What the unit tests of `src/secrets.rs` open and compare against, made by Navidrome's own code (the CreeperUX fork at
0.64.2-sonus.10), so "byte-compatible with Go" is checked against Go, not against this server's reading of it.

| File | Made by |
|---|---|
| `encrypt_default_key.in` | `utils.Encrypt` with the key sha256(`"just for obfuscation"`), Navidrome's default |
| `encrypt_custom_key.in` | `utils.Encrypt` with the key sha256(`"sonus golden key ✓"`) |
| `key_hash.in` | `keyHash` of `core/twofactor/store.go` (copied into the generator: it is not exported) |

Each is a Rust slice of `(input, output)` pairs, included by the tests. The texts are made up; nothing here is a
credential of anything.

## Making them again

`generate.go.txt` is the generator (a Go `main` package; `.txt` so no tool takes this folder for Go code). It needs Go
and a checkout of the fork:

```sh
mkdir gen && cp generate.go.txt gen/main.go && cd gen
printf 'module gogold\n\ngo 1.27\n\nrequire github.com/navidrome/navidrome v0.0.0\n\nreplace github.com/navidrome/navidrome => "<the fork>"\n' > go.mod
GOFLAGS=-mod=mod go run . <this folder>
```

Encryption uses a random nonce, so new files differ from these; both open.

## The reverse: Go opens what this server seals

The generator also takes `<key> <text> <sealed>` triples and says whether Navidrome's `utils.Decrypt` opens `<sealed>`
with sha256(`<key>`) to `<text>`:

```sh
sealed=$(cargo run --quiet --example seal -- "" "some text")            # "" is no PasswordEncryptionKey
go run . /tmp/out "just for obfuscation" "some text" "$sealed"          # go opens rust's: true
```

Checked on 2026-11-24 with both keys (true, true) and with the wrong key as a control (false).
