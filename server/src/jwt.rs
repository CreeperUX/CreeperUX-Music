//! Session tokens, the very ones Navidrome makes and checks (`core/auth/auth.go`, go-chi/jwtauth over
//! lestrrat-go/jwx): JWTs signed with HS256 and the secret both servers read from the `property` table, so a token
//! either server issues is accepted by the other. That is what lets the web UI sign in here and then use Navidrome's
//! `/api`, where Navidrome keeps refreshing the token it was given.
//!
//! The claims: `iss` ("ND"), `sub` (the user name), `iat`, `exp`, `uid` (the user's id), `adm` (when an admin), `ep`
//! (the user's token epoch when it is not 0: a password change bumps it, which revokes every token before it) and
//! `aud` (when the token is for one use only: the two-step verification setup). Zero values are left out, as
//! Navidrome's `Claims.ToMap` leaves them out.
//!
//! Only HS256 is accepted, whatever a token's header says.
//!
//! Ported from Navidrome (GPL-3.0), © the Navidrome authors.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;

/// Navidrome's `consts.JWTIssuer`.
pub const ISSUER: &str = "ND";

/// The audience of Navidrome's own API, which a session token for the web UI must allow (`auth.AudienceNative`).
pub const AUDIENCE_NATIVE: &str = "native";

/// The header jwx writes.
const HEADER: &str = r#"{"alg":"HS256","typ":"JWT"}"#;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Claims {
    pub issuer: String,
    /// The user name.
    pub subject: String,
    /// Which use the token is for; empty: any.
    pub audience: Vec<String>,
    /// Seconds since 1970; 0 when the token has none.
    pub issued_at: i64,
    pub expires_at: i64,
    pub user_id: String,
    pub is_admin: bool,
    /// The user's token epoch when the token was made.
    pub epoch: i64,
    /// What a public link names (`id`: an artwork id), in the tokens signed with the public secret.
    pub id: String,
}

impl Claims {
    fn to_json(&self) -> Value {
        let mut m = Map::new();
        if !self.issuer.is_empty() {
            m.insert("iss".into(), json!(self.issuer));
        }
        if !self.subject.is_empty() {
            m.insert("sub".into(), json!(self.subject));
        }
        if !self.audience.is_empty() {
            m.insert("aud".into(), json!(self.audience));
        }
        if self.issued_at != 0 {
            m.insert("iat".into(), json!(self.issued_at));
        }
        if self.expires_at != 0 {
            m.insert("exp".into(), json!(self.expires_at));
        }
        if !self.user_id.is_empty() {
            m.insert("uid".into(), json!(self.user_id));
        }
        if self.is_admin {
            m.insert("adm".into(), json!(true));
        }
        if self.epoch != 0 {
            m.insert("ep".into(), json!(self.epoch));
        }
        if !self.id.is_empty() {
            m.insert("id".into(), json!(self.id));
        }
        Value::Object(m)
    }

    fn from_json(value: &Value) -> Option<Claims> {
        let m = value.as_object()?;
        let text = |key: &str| m.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        // a number as jwx reads one: an integer, or a float cut to one
        let number = |key: &str| m.get(key).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(0);
        let audience = match m.get("aud") {
            Some(Value::String(one)) => vec![one.clone()],
            Some(Value::Array(many)) => many.iter().filter_map(|a| a.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        Some(Claims {
            issuer: text("iss"),
            subject: text("sub"),
            audience,
            issued_at: number("iat"),
            expires_at: number("exp"),
            user_id: text("uid"),
            is_admin: m.get("adm").and_then(Value::as_bool).unwrap_or(false),
            epoch: number("ep"),
            id: text("id"),
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum TokenError {
    /// Not three base64url parts, not JSON, or not HS256.
    Malformed,
    /// Signed with another secret, or changed since.
    BadSignature,
    Expired,
    /// Issued in the future, or not valid yet (`nbf`).
    NotYetValid,
}

/// Why a valid token does not open what it is shown to (Navidrome's `CheckClaims`).
#[derive(Debug, PartialEq)]
pub enum ClaimError {
    /// Made for another user who had this name (the name was reused).
    WrongUser,
    /// The user's password changed since: the token's epoch is not the user's.
    Revoked,
    /// Made for another use.
    WrongAudience,
}

/// Navidrome's `CheckClaims`: a verified token against the user it names and the use it is put to.
pub fn check(claims: &Claims, user_id: &str, token_epoch: i64, audience: &str) -> Result<(), ClaimError> {
    if !claims.user_id.is_empty() && claims.user_id != user_id {
        return Err(ClaimError::WrongUser);
    }
    if claims.epoch != token_epoch {
        return Err(ClaimError::Revoked);
    }
    if !claims.audience.is_empty() && !claims.audience.iter().any(|a| a == audience) {
        return Err(ClaimError::WrongAudience);
    }
    Ok(())
}

/// Signs and verifies with the session secret.
#[derive(Clone)]
pub struct Signer {
    secret: Vec<u8>,
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Signer(…)")
    }
}

impl Signer {
    pub fn new(secret: &[u8]) -> Signer {
        Signer { secret: secret.to_vec() }
    }

    fn mac(&self, signing_input: &[u8]) -> Hmac<Sha256> {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.secret).expect("HMAC takes a key of any length");
        mac.update(signing_input);
        mac
    }

    pub fn sign(&self, claims: &Claims) -> String {
        let mut token = URL_SAFE_NO_PAD.encode(HEADER);
        token.push('.');
        token.push_str(&URL_SAFE_NO_PAD.encode(claims.to_json().to_string()));
        let signature = self.mac(token.as_bytes()).finalize().into_bytes();
        token.push('.');
        token.push_str(&URL_SAFE_NO_PAD.encode(signature));
        token
    }

    /// The claims of a token this secret signed, valid at `now` (seconds since 1970), as jwx's `Validate` decides it:
    /// not expired, not issued in the future, not before `nbf`.
    pub fn verify(&self, token: &str, now: i64) -> Result<Claims, TokenError> {
        let mut parts = token.split('.');
        let (Some(header), Some(payload), Some(signature), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
            return Err(TokenError::Malformed);
        };
        let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| TokenError::Malformed);
        let header: Value = serde_json::from_slice(&decode(header)?).map_err(|_| TokenError::Malformed)?;
        if header.get("alg").and_then(Value::as_str) != Some("HS256") {
            return Err(TokenError::Malformed);
        }
        let signed = &token[..token.len() - signature.len() - 1];
        // constant-time, by the MAC itself
        self.mac(signed.as_bytes()).verify_slice(&decode(signature)?).map_err(|_| TokenError::BadSignature)?;
        let payload: Value = serde_json::from_slice(&decode(payload)?).map_err(|_| TokenError::Malformed)?;
        let claims = Claims::from_json(&payload).ok_or(TokenError::Malformed)?;
        if payload.get("exp").is_some() && now >= claims.expires_at {
            return Err(TokenError::Expired);
        }
        let not_before = payload.get("nbf").and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(0);
        if claims.issued_at > now || not_before > now {
            return Err(TokenError::NotYetValid);
        }
        Ok(claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tokens made by Navidrome's own stack (jwtauth.New("HS256", secret).Encode), see tests/golden/README.md:
    // (name, secret, token).
    const FROM_GO: &[(&str, &str, &str)] = include!("../tests/golden/jwt.in");
    const NOW: i64 = 1_800_000_000;

    fn go(name: &str) -> (Signer, &'static str) {
        let (_, secret, token) = FROM_GO.iter().find(|(n, _, _)| *n == name).unwrap_or_else(|| panic!("no golden token {name}"));
        (Signer::new(secret.as_bytes()), token)
    }

    #[test]
    fn a_session_token_from_go_verifies_with_its_claims() {
        let (signer, token) = go("session");
        let claims = signer.verify(token, NOW).unwrap();
        assert_eq!(
            claims,
            Claims {
                issuer: "ND".into(),
                subject: "alice".into(),
                audience: vec![],
                issued_at: 1_700_000_000,
                expires_at: 4_102_444_800,
                user_id: "1h0kQuAetIeA34EYHnVwu1".into(),
                is_admin: true,
                epoch: 3,
                id: String::new(),
            }
        );
        assert_eq!(check(&claims, "1h0kQuAetIeA34EYHnVwu1", 3, AUDIENCE_NATIVE), Ok(()));
    }

    #[test]
    fn a_plain_users_token_has_neither_adm_nor_ep() {
        let (signer, token) = go("plain");
        let claims = signer.verify(token, NOW).unwrap();
        assert_eq!((claims.subject.as_str(), claims.is_admin, claims.epoch), ("林夕雨", false, 0));
    }

    #[test]
    fn a_setup_token_from_go_is_for_the_setup_only() {
        let (signer, token) = go("setup");
        let claims = signer.verify(token, NOW).unwrap();
        assert_eq!(claims.audience, ["sonus-2fa-setup"]);
        assert_eq!(check(&claims, &claims.user_id, 0, "sonus-2fa-setup"), Ok(()));
        for api in ["native", "subsonic", "jellyfin"] {
            assert_eq!(check(&claims, &claims.user_id, 0, api), Err(ClaimError::WrongAudience));
        }
    }

    #[test]
    fn what_this_server_signs_is_what_go_signs() {
        // the same header, claims and secret: the same signature over Go's own bytes
        let (signer, token) = go("session");
        let (signed, signature) = token.rsplit_once('.').unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(signer.mac(signed.as_bytes()).finalize().into_bytes()), signature);
        assert_eq!(signed.split('.').next().unwrap(), URL_SAFE_NO_PAD.encode(HEADER), "jwx's header");
        // and a token made here reads back
        let claims = signer.verify(token, NOW).unwrap();
        let ours = signer.sign(&claims);
        assert_eq!(signer.verify(&ours, NOW), Ok(claims));
    }

    #[test]
    fn expired_forged_and_malformed_tokens_are_refused() {
        let (signer, expired) = go("expired");
        assert_eq!(signer.verify(expired, NOW), Err(TokenError::Expired));
        assert!(signer.verify(expired, 1_700_000_050).is_ok(), "it was valid before its time ran out");
        assert_eq!(signer.verify(expired, 1_700_000_100), Err(TokenError::Expired), "at exp itself it is over");

        let (signer, token) = go("session");
        assert_eq!(Signer::new(b"another secret").verify(token, NOW), Err(TokenError::BadSignature));
        assert_eq!(signer.verify(token, 1_600_000_000), Err(TokenError::NotYetValid), "issued in the future");
        // the payload changed (alice made bob), the signature kept
        let mut parts: Vec<String> = token.split('.').map(str::to_string).collect();
        let payload = String::from_utf8(URL_SAFE_NO_PAD.decode(&parts[1]).unwrap()).unwrap().replace("alice", "bobby");
        parts[1] = URL_SAFE_NO_PAD.encode(payload);
        assert_eq!(signer.verify(&parts.join("."), NOW), Err(TokenError::BadSignature));

        for bad in ["", "abc", "a.b", "a.b.c.d", "!!.!!.!!", &format!("{token}.x")] {
            assert_eq!(signer.verify(bad, NOW), Err(TokenError::Malformed), "{bad}");
        }
    }

    #[test]
    fn only_hs256_is_accepted() {
        let (signer, token) = go("session");
        let payload = token.split('.').nth(1).unwrap();
        // "alg": "none", unsigned
        let none = format!("{}.{payload}.", URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#));
        assert_eq!(signer.verify(&none, NOW), Err(TokenError::Malformed));
        // another HMAC, signed with the right secret
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS512","typ":"JWT"}"#);
        let signed = format!("{header}.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signer.mac(signed.as_bytes()).finalize().into_bytes());
        assert_eq!(signer.verify(&format!("{signed}.{signature}"), NOW), Err(TokenError::Malformed));
    }

    #[test]
    fn claims_are_checked_as_navidrome_checks_them() {
        let claims = Claims { user_id: "u1".into(), epoch: 2, ..Claims::default() };
        assert_eq!(check(&claims, "u1", 2, "native"), Ok(()));
        assert_eq!(check(&claims, "u1", 3, "native"), Err(ClaimError::Revoked), "the password changed since");
        assert_eq!(check(&claims, "u1", 0, "native"), Err(ClaimError::Revoked));
        assert_eq!(check(&claims, "u2", 2, "native"), Err(ClaimError::WrongUser), "the name was reused by a new user");
        let no_id = Claims { epoch: 0, ..Claims::default() };
        assert_eq!(check(&no_id, "anyone", 0, "native"), Ok(()), "a token from before ids and epochs, for a user never bumped");
        let scoped = Claims { audience: vec!["jellyfin".into(), "native".into()], ..Claims::default() };
        assert_eq!(check(&scoped, "u", 0, "native"), Ok(()));
        assert_eq!(check(&scoped, "u", 0, "subsonic"), Err(ClaimError::WrongAudience));
    }

    #[test]
    fn zero_values_are_left_out_as_navidrome_leaves_them_out() {
        let bare = Claims { issuer: ISSUER.into(), subject: "u".into(), ..Claims::default() };
        assert_eq!(bare.to_json().to_string(), r#"{"iss":"ND","sub":"u"}"#);
        let full = Claims {
            issuer: ISSUER.into(),
            subject: "u".into(),
            audience: vec!["a".into()],
            issued_at: 1,
            expires_at: 2,
            user_id: "id".into(),
            is_admin: true,
            epoch: 4,
            id: String::new(),
        };
        let json = full.to_json();
        assert_eq!(json, json!({"iss": "ND", "sub": "u", "aud": ["a"], "iat": 1, "exp": 2, "uid": "id", "adm": true, "ep": 4}));
        assert_eq!(Claims::from_json(&json), Some(full));
        // an audience as one string, numbers as floats: read as jwx reads them
        let loose = json!({"sub": "u", "aud": "a", "ep": 4.0, "exp": 2.9});
        let claims = Claims::from_json(&loose).unwrap();
        assert_eq!((claims.audience, claims.epoch, claims.expires_at), (vec!["a".to_string()], 4, 2));
    }
}
