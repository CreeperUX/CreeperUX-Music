//! Runs Navidrome behind the gateway: on a local port, trusting the gateway alone, with the container's environment
//! otherwise as it was (the gateway's decisions on top, see `NavidromeProcess::env`). Its output goes where the
//! gateway's goes (the container's log). When it stops, the gateway stops too, so the container restarts as it did
//! when Navidrome was the container.

use std::io;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::process::{Child, Command};

use crate::config::NavidromeProcess;

pub struct Navidrome {
    child: Child,
}

impl Navidrome {
    pub fn start(p: &NavidromeProcess) -> io::Result<Navidrome> {
        let mut cmd = Command::new(&p.bin);
        cmd.args(&p.args);
        for name in &p.env_remove {
            cmd.env_remove(name);
        }
        for (name, value) in &p.env {
            cmd.env(name, value);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).kill_on_drop(true);
        let child = cmd.spawn().map_err(|e| io::Error::new(e.kind(), format!("cannot start Navidrome ({}): {e}", p.bin.display())))?;
        Ok(Navidrome { child })
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait().await
    }

    /// Asks Navidrome to stop (SIGTERM, as Docker asks a container), and kills it after `grace`.
    pub async fn stop(&mut self, grace: Duration) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            // SAFETY: kill(2) on our own child's pid, which has not been reaped (wait has not returned).
            #[allow(unsafe_code)]
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        let _ = self.child.start_kill();
        if tokio::time::timeout(grace, self.child.wait()).await.is_err() {
            tracing::warn!("Navidrome did not stop within {}s: killing it", grace.as_secs());
            let _ = self.child.kill().await;
        }
    }
}

/// The gateway's exit code when Navidrome stopped on its own: Navidrome's, so the container's log and restart policy
/// see what they saw before; 128 + the signal when a signal ended it (as a shell reports it); and 1 for a clean exit,
/// since the server stopping by itself is a failure (a restart policy of `on-failure` restarts it).
pub fn exit_code(status: ExitStatus) -> u8 {
    if let Some(code) = status.code() {
        return u8::try_from(code).ok().filter(|c| *c != 0).unwrap_or(1);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return u8::try_from(128 + signal).unwrap_or(1);
        }
    }
    1
}
