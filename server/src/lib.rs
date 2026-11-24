//! The Sonus music server. For now a gateway: it listens where Navidrome used to (`ND_ADDRESS`, `ND_PORT`), runs
//! Navidrome (the CreeperUX fork, frozen at 0.64.2) behind it on a local port, and passes every request through. Parts
//! of the server move here one by one, behind the same APIs; see `server/README.md`.
#![deny(unsafe_code)]

pub mod config;
pub mod db;
pub mod gateway;
pub mod gotime;
pub mod routes;
pub mod secrets;
pub mod startup;
pub mod subsonic;
pub mod supervisor;
pub mod trust;

/// "0.1.0 (abc1234)": the crate's version and, in images, the commit it was built from (`SONUS_GIT_SHA` at build time).
pub fn version() -> String {
    match option_env!("SONUS_GIT_SHA") {
        Some(sha) if !sha.is_empty() => format!("{} ({})", env!("CARGO_PKG_VERSION"), &sha[..sha.len().min(7)]),
        _ => env!("CARGO_PKG_VERSION").to_string(),
    }
}
