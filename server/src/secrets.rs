//! Secrets as Navidrome keeps them, byte for byte, so both servers read what either wrote.
//!
//! Account passwords, app passwords and authenticator secrets are encrypted, not hashed (Subsonic's `t`/`s` sign-in
//! needs the password itself): AES-256-GCM, the key being sha256 of `PasswordEncryptionKey` (or of Navidrome's
//! built-in default when none is set), stored as base64(nonce ‖ ciphertext ‖ tag) with a random 12-byte nonce
//! (Navidrome's `utils/encrypt.go`). API keys are found by the sha256 of the key as typed, normalized
//! (`core/twofactor/store.go`, `keyHash`).
//!
//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};

/// Navidrome's `consts.DefaultEncryptionKey`: what secrets are sealed with when no `PasswordEncryptionKey` is set.
/// Public knowledge, so without a key of the operator's own the encryption only obscures.
pub const DEFAULT_ENCRYPTION_KEY: &str = "just for obfuscation";

const NONCE_LEN: usize = 12;

/// The keys secrets are sealed and opened with.
#[derive(Clone)]
pub struct Keys {
    /// sha256(`PasswordEncryptionKey`) when one is set, else the default key: new secrets are sealed with it.
    seal: [u8; 32],
    /// The default key, when it is not `seal`: what was sealed before a key was set still opens, as in Navidrome.
    fallback: Option<[u8; 32]>,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Keys(…)")
    }
}

impl Keys {
    /// `password_encryption_key`: Navidrome's setting, empty when unset.
    pub fn new(password_encryption_key: &str) -> Keys {
        let default = sha256(DEFAULT_ENCRYPTION_KEY.as_bytes());
        if password_encryption_key.is_empty() {
            Keys { seal: default, fallback: None }
        } else {
            Keys { seal: sha256(password_encryption_key.as_bytes()), fallback: Some(default) }
        }
    }

    /// Encrypts as Navidrome's `utils.Encrypt`.
    pub fn seal(&self, plain: &[u8]) -> Result<String, SecretError> {
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(|_| SecretError::Random)?;
        seal_with(&self.seal, &nonce, plain)
    }

    /// Decrypts what Navidrome's `utils.Encrypt` (or `seal`) made, with the configured key, else the default one.
    ///
    /// Navidrome opens app passwords and authenticator secrets with both keys, and account passwords with the one
    /// key it settled on at start. Both are tried here for all of them: GCM authenticates, so a wrong key opens
    /// nothing, and the default key is public anyway.
    pub fn open(&self, sealed: &str) -> Result<Vec<u8>, SecretError> {
        let data = STANDARD.decode(sealed.trim_matches(['\r', '\n'])).map_err(|_| SecretError::Unreadable)?;
        if data.len() < NONCE_LEN {
            return Err(SecretError::Unreadable);
        }
        let (nonce, ciphertext) = data.split_at(NONCE_LEN);
        let nonce = Nonce::try_from(nonce).map_err(|_| SecretError::Unreadable)?;
        for key in std::iter::once(&self.seal).chain(self.fallback.as_ref()) {
            let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SecretError::Unreadable)?;
            if let Ok(plain) = cipher.decrypt(&nonce, ciphertext) {
                return Ok(plain);
            }
        }
        Err(SecretError::Unreadable)
    }
}

fn seal_with(key: &[u8; 32], nonce: &[u8; NONCE_LEN], plain: &[u8]) -> Result<String, SecretError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| SecretError::Unreadable)?;
    let nonce_ref = Nonce::try_from(&nonce[..]).map_err(|_| SecretError::Unreadable)?;
    let ciphertext = cipher.encrypt(&nonce_ref, plain).map_err(|_| SecretError::Unreadable)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(out))
}

#[derive(Debug, PartialEq)]
pub enum SecretError {
    /// Not base64, too short, or sealed with another key (was `PasswordEncryptionKey` changed?).
    Unreadable,
    /// The system gave no random bytes.
    Random,
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            SecretError::Unreadable => "a stored secret cannot be read: was PasswordEncryptionKey changed?",
            SecretError::Random => "the system gave no random bytes",
        })
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// Go's `hex.DecodeString`: both cases, an even number of digits, nothing else.
pub fn unhex(text: &[u8]) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    text.chunks(2).map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?)).collect()
}

/// How an app password is found from what a client sends as an API key: as shown or without its dashes and spaces,
/// in any case (Navidrome's `keyHash`). The hex sha256 of that.
pub fn api_key_hash(key: &[u8]) -> String {
    // Go: strings.ToLower(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(key)))
    let text = String::from_utf8_lossy(key);
    let normal: String = text.trim().chars().filter(|c| *c != '-' && *c != ' ').flat_map(char::to_lowercase).collect();
    hex(&sha256(normal.as_bytes()))
}

/// The hex md5 of password ‖ salt: Subsonic's token (`t`, with `s`).
pub fn subsonic_token(password: &[u8], salt: &[u8]) -> String {
    use md5::Md5;
    let mut hasher = Md5::new();
    hasher.update(password);
    hasher.update(salt);
    hex(&hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Made by Navidrome's own utils.Encrypt (the fork at 0.64.2-sonus.10), key sha256(PasswordEncryptionKey):
    // see server/README.md, "Golden values from Go".
    const GO_DEFAULT_KEY: &[(&str, &str)] = include!("../tests/golden/encrypt_default_key.in");
    const GO_CUSTOM_KEY: &[(&str, &str)] = include!("../tests/golden/encrypt_custom_key.in");
    const CUSTOM_KEY: &str = "sonus golden key ✓";

    #[test]
    fn opens_what_go_sealed() {
        let keys = Keys::new("");
        for (plain, sealed) in GO_DEFAULT_KEY {
            assert_eq!(keys.open(sealed).as_deref(), Ok(plain.as_bytes()), "{plain:?}");
        }
        let keys = Keys::new(CUSTOM_KEY);
        for (plain, sealed) in GO_CUSTOM_KEY {
            assert_eq!(keys.open(sealed).as_deref(), Ok(plain.as_bytes()), "{plain:?}");
        }
    }

    #[test]
    fn with_a_key_set_what_the_default_key_sealed_still_opens() {
        let keys = Keys::new(CUSTOM_KEY);
        for (plain, sealed) in GO_DEFAULT_KEY {
            assert_eq!(keys.open(sealed).as_deref(), Ok(plain.as_bytes()));
        }
    }

    #[test]
    fn another_key_opens_nothing() {
        let (_, sealed) = GO_CUSTOM_KEY[0];
        assert_eq!(Keys::new("").open(sealed), Err(SecretError::Unreadable));
        assert_eq!(Keys::new("some other key").open(sealed), Err(SecretError::Unreadable));
    }

    #[test]
    fn seals_in_gos_format() {
        // the same key, nonce and text give the very bytes Go's AES-GCM gives
        let (plain, sealed) = GO_DEFAULT_KEY[0];
        let raw = STANDARD.decode(sealed).unwrap();
        let nonce: [u8; NONCE_LEN] = raw[..NONCE_LEN].try_into().unwrap();
        assert_eq!(seal_with(&sha256(DEFAULT_ENCRYPTION_KEY.as_bytes()), &nonce, plain.as_bytes()).unwrap(), sealed);
    }

    #[test]
    fn a_round_trip_with_a_new_nonce_each_time() {
        let keys = Keys::new(CUSTOM_KEY);
        let a = keys.seal("pässword 密码".as_bytes()).unwrap();
        let b = keys.seal("pässword 密码".as_bytes()).unwrap();
        assert_ne!(a, b);
        assert_eq!(keys.open(&a).unwrap(), "pässword 密码".as_bytes());
        assert_eq!(STANDARD.decode(&a).unwrap().len(), NONCE_LEN + "pässword 密码".len() + 16);
    }

    #[test]
    fn damaged_secrets_are_unreadable() {
        let keys = Keys::new("");
        let (_, sealed) = GO_DEFAULT_KEY[0];
        let mut raw = STANDARD.decode(sealed).unwrap();
        *raw.last_mut().unwrap() ^= 1;
        assert_eq!(keys.open(&STANDARD.encode(&raw)), Err(SecretError::Unreadable));
        assert_eq!(keys.open(""), Err(SecretError::Unreadable));
        assert_eq!(keys.open("not base64!"), Err(SecretError::Unreadable));
        assert_eq!(keys.open("AAAA"), Err(SecretError::Unreadable));
    }

    #[test]
    fn api_key_hashes_as_go_hashes_them() {
        // Go: keyHash("abcd-efgh-jkmn-pqrs") == keyHash(" ABCDEFGH JKMN-PQRS ")
        let golden: &[(&str, &str)] = include!("../tests/golden/key_hash.in");
        for (key, hash) in golden {
            assert_eq!(api_key_hash(key.as_bytes()), *hash, "{key:?}");
        }
        assert_eq!(api_key_hash(b"abcd-efgh-jkmn-pqrs"), api_key_hash(b" ABCDEFGH JKMN-PQRS "));
    }

    #[test]
    fn tokens_are_md5_of_password_and_salt() {
        // the Subsonic API's own example: password "sesame", salt "c19b2d"
        assert_eq!(subsonic_token(b"sesame", b"c19b2d"), "26719a1196d2a940705a59634eb18eab");
    }

    #[test]
    fn hex_as_go_decodes_it() {
        assert_eq!(unhex(b"736573616d65").as_deref(), Some(&b"sesame"[..]));
        assert_eq!(unhex(b"7365AB").as_deref(), Some(&[0x73, 0x65, 0xab][..]));
        assert_eq!(unhex(b"736"), None);
        assert_eq!(unhex(b"zz"), None);
        assert_eq!(unhex(b"").as_deref(), Some(&[][..]));
    }
}
