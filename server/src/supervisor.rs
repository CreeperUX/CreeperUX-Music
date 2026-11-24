//! Runs Navidrome behind the gateway: on a local port, trusting the gateway alone, with the container's environment
//! otherwise as it was. Its output goes where the gateway's goes (the container's log). When it stops, the gateway
//! stops too, so the container restarts as it did when Navidrome was the container.

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
        cmd.args(&p.args)
            .env("ND_ADDRESS", "127.0.0.1")
            .env("ND_PORT", p.port.to_string())
            // Only the gateway reaches it, and the gateway has already decided who the client is (trust.rs): its
            // X-Real-IP is the client's address, and a user header it passes on came from a trusted proxy.
            .env("ND_EXTAUTH_TRUSTEDSOURCES", "127.0.0.1/32")
            .env_remove("ND_REVERSEPROXYWHITELIST")
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
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
