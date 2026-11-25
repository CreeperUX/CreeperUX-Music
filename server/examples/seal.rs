//! Seals a text as the server seals secrets, for checking against Navidrome's own code (tests/golden/README.md):
//!   cargo run --quiet --example seal -- <PasswordEncryptionKey, or "" for none> <text>

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(key), Some(text)) = (args.next(), args.next()) else {
        eprintln!("usage: seal <PasswordEncryptionKey or \"\"> <text>");
        std::process::exit(2);
    };
    println!("{}", sonus_server::secrets::Keys::new(&key).seal(text.as_bytes()).expect("random bytes"));
}
