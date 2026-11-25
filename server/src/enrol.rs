//! `sonus-server enrolment-code <user> [--reset]`: an enrolment code made on the server's own command line, for when
//! no admin can make one in the browser. That is the first admin who did not set two-step verification up in the
//! minutes after the account was made, an only admin from before enrolment codes, or one who lost the authenticator
//! and the recovery codes (`--reset` removes their two-step verification first). Whoever can run this can read and
//! write the database file anyway, so it asks for no credentials.
//!
//! It reads Navidrome's settings as the server does (the same environment, config file and flags), opens the
//! database beside the running server (SQLite takes both), and prints the code once.

use std::ffi::OsString;

use chrono::Utc;

use crate::auth::store::{self, Issued};
use crate::config::{Config, RealFiles, Sources, TwoFactor};
use crate::db::{self, Db};

/// The subcommand's name, the first argument.
pub const COMMAND: &str = "enrolment-code";

const USAGE: &str = "usage: sonus-server enrolment-code <user name> [--reset]\n\
                     \x20 Makes a one-time enrolment code for a user who has no two-step verification, and prints it.\n\
                     \x20 --reset  removes the user's two-step verification first (a lost authenticator and no recovery codes)";

/// Runs the subcommand with the arguments after its name. Ok: what to print. Err: why there is no code.
pub fn run(args: Vec<OsString>, var: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let mut reset = false;
    let mut username = None;
    let mut rest = Vec::new();
    for arg in args {
        match arg.to_str() {
            Some("--reset") => reset = true,
            Some("--help" | "-h") => return Ok(USAGE.into()),
            Some(name) if username.is_none() && !name.starts_with('-') => username = Some(name.to_string()),
            _ => rest.push(arg),
        }
    }
    let username = username.ok_or(USAGE)?;
    let config = Config::load(Sources { var, args: rest, files: &RealFiles })?;
    let shared = config.shared;
    if shared.two_factor != TwoFactor::Required {
        return Err("two-step verification is not required on this server (Sonus.TwoFactor): nobody needs an enrolment code".into());
    }
    let path = db::locate(&shared.data_folder, &shared.db_path)?;
    let db = Db::open(&path)?;
    db.read_blocking(|conn| Ok(db::check_sqlite(conn).and_then(|()| db::check_schema(conn)))).map_err(|e| e.to_string())??;
    store::prepare(&db)?;
    let user_id = store::user_id(&db, &username).map_err(|e| e.to_string())?.ok_or_else(|| format!("no user named {username}"))?;
    if reset {
        store::disable(&db, &user_id).map_err(|e| e.to_string())?;
    }
    match store::issue_enrolment_code(&db, &user_id, "server", Utc::now()).map_err(|e| e.to_string())? {
        Issued::Code(code, until) => Ok(format!(
            "Enrolment code for {username}: {code}\nIt works once, until {}. The user signs in with their password and enters it to set two-step verification up.{}",
            until.format("%Y-%m-%d %H:%M UTC"),
            if reset { "\nTheir two-step verification was removed; their app passwords and signed-in apps keep working." } else { "" }
        )),
        Issued::NoSuchUser => Err(format!("no user named {username}")),
        Issued::AlreadySetUp => Err(format!("{username} has two-step verification set up: with --reset it is removed first")),
    }
}
