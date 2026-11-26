// The arguments the tools start the Rust server with (`cargo run` in server/).
//
// The server's default `tls` feature (the R2 mirror's HTTPS client) builds `ring`, which needs clang on Windows on
// ARM. Where it cannot build, the tools build without it (`--no-default-features`): the mirror then speaks plain http
// to loopback only, and nothing the tools check uses it.
//
//   SONUS_CARGO_NO_TLS=1   always build without the `tls` feature
//   SONUS_CARGO_NO_TLS=0   always build with the default features (CI: the build it ships)
//   unset                  without, on Windows on ARM when no clang is on PATH; with the default features elsewhere
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function clangOnPath(env) {
  const path = env.PATH ?? env.Path ?? '';
  const names = process.platform === 'win32' ? ['clang.exe', 'clang.cmd', 'clang.bat'] : ['clang'];
  return path.split(delimiter).some(dir => dir && names.some(name => existsSync(join(dir, name))));
}

/** Whether `cargo` should leave the default features out: see above. */
export function cargoWithoutTls(env = process.env) {
  const said = (env.SONUS_CARGO_NO_TLS ?? '').trim();
  if (said === '1' || /^(true|yes)$/i.test(said)) return true;
  if (said === '0' || /^(false|no)$/i.test(said)) return false;
  return process.platform === 'win32' && process.arch === 'arm64' && !clangOnPath(env);
}

/** `cargo run` for server/Cargo.toml at `manifest`, then `extra` (e.g. ['--', 'enrolment-code', 'owner']). */
export function cargoRunArgs(manifest, { release = false, extra = [], env = process.env } = {}) {
  return ['run', '--quiet', ...(release ? ['--release'] : []), ...(cargoWithoutTls(env) ? ['--no-default-features'] : []), '--manifest-path', manifest, ...extra];
}
