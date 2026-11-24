//! Ids and the random strings people read and type, as Navidrome and the fork make them.

/// Go's `big.Int.Text(62)` digits.
const BASE62: &[u8; 62] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/// Navidrome's `id.Encode`: 128 bits as 22 base62 digits, zero-padded.
pub fn encode(value: u128) -> String {
    let mut digits = [b'0'; 22];
    let mut rest = value;
    for slot in digits.iter_mut().rev() {
        *slot = BASE62[(rest % 62) as usize];
        rest /= 62;
    }
    String::from_utf8(digits.to_vec()).expect("ASCII")
}

/// Navidrome's `id.NewRandom`: a new id for a user, an app password, …
pub fn new_random() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)?;
    Ok(encode(u128::from_be_bytes(bytes)))
}

/// The fork's alphabet for what people read and type (`core/twofactor/store.go`): no 0/o, no 1/l/i.
const READABLE: &[u8; 31] = b"abcdefghjkmnpqrstuvwxyz23456789";

/// The fork's `randomString`: `n` random characters of the readable alphabet, each equally likely, in groups
/// (`abcd-efgh-…`): app passwords (16 in fours), API keys (32 in fours), recovery codes (10 in fives).
pub fn readable(n: usize, group: usize) -> Result<String, getrandom::Error> {
    let limit = (256 - 256 % READABLE.len()) as u8; // bytes past this would favour the first letters
    let mut out = String::with_capacity(n + n / group.max(1));
    let mut count = 0;
    let mut buffer = [0u8; 32];
    while count < n {
        getrandom::fill(&mut buffer)?;
        for byte in buffer {
            if byte >= limit || count == n {
                continue;
            }
            if count > 0 && count % group == 0 {
                out.push('-');
            }
            out.push(READABLE[byte as usize % READABLE.len()] as char);
            count += 1;
        }
    }
    Ok(out)
}

/// The fork's alphabet for the code an app shows during the browser sign-in: letters that make no words and are not
/// mistaken for each other.
const USER_CODE: &[u8; 20] = b"BCDFGHJKLMNPQRSTVWXZ";

/// The fork's `randomUserCode`: `ABCD-EFGH`. (256 is not a multiple of 20: a slight lean towards the first sixteen
/// letters, as in the fork; harmless for a code shown to compare.)
pub fn user_code() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes)?;
    let mut out = String::with_capacity(9);
    for (i, byte) in bytes.iter().enumerate() {
        if i == 4 {
            out.push('-');
        }
        out.push(USER_CODE[*byte as usize % USER_CODE.len()] as char);
    }
    Ok(out)
}

/// `n` random bytes as lowercase hex.
pub fn random_hex(n: usize) -> Result<String, getrandom::Error> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes)?;
    Ok(crate::secrets::hex(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_encoded_as_go_encodes_them() {
        // Go: id.Encode of these 16 bytes (fmt "%022s" of big.Int.Text(62))
        assert_eq!(encode(0), "0000000000000000000000");
        assert_eq!(encode(61), "000000000000000000000Z");
        assert_eq!(encode(62), "0000000000000000000010");
        assert_eq!(encode(u128::MAX), "7N42dgm5tFLK9N8MT7fHC7");
        let id = new_random().unwrap();
        assert_eq!(id.len(), 22);
        assert!(id.bytes().all(|b| b.is_ascii_alphanumeric()));
        assert_ne!(id, new_random().unwrap());
    }

    #[test]
    fn readable_strings_are_grouped_and_leave_out_what_is_misread() {
        let app = readable(16, 4).unwrap();
        assert_eq!(app.len(), 19);
        let groups: Vec<&str> = app.split('-').collect();
        assert_eq!(groups.len(), 4);
        assert!(groups.iter().all(|g| g.len() == 4 && g.bytes().all(|b| READABLE.contains(&b))), "{app}");
        assert_eq!(readable(32, 4).unwrap().replace('-', "").len(), 32);
        let recovery = readable(10, 5).unwrap();
        assert_eq!((recovery.len(), recovery.as_bytes()[5]), (11, b'-'));
        let many = readable(2000, 2000).unwrap();
        for misread in ['0', 'o', '1', 'l', 'i'] {
            assert!(!many.contains(misread));
        }
        for letter in READABLE {
            assert!(many.contains(*letter as char), "every letter turns up in 2000");
        }
    }

    #[test]
    fn user_codes_are_two_groups_of_four_letters() {
        let code = user_code().unwrap();
        assert_eq!(code.len(), 9);
        assert_eq!(code.as_bytes()[4], b'-');
        assert!(code.bytes().filter(|b| *b != b'-').all(|b| USER_CODE.contains(&b)), "{code}");
        assert_eq!(random_hex(32).unwrap().len(), 64);
    }
}
