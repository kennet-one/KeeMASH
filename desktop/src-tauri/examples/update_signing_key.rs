use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let command = args
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or(
            "usage: update_signing_key <generate|public|sign> <private-key-path> [payload-path]",
        )?;
    let path = args
        .next()
        .map(PathBuf::from)
        .ok_or("private key path is required")?;
    if command == "public" || command == "sign" {
        let encoded = fs::read_to_string(&path)?;
        let bytes: [u8; 32] = STANDARD
            .decode(encoded.trim())?
            .try_into()
            .map_err(|_| "private key must contain exactly 32 bytes")?;
        let signing = SigningKey::from_bytes(&bytes);
        if command == "public" {
            println!("{}", STANDARD.encode(signing.verifying_key().to_bytes()));
            return Ok(());
        }
        let payload_path = args
            .next()
            .map(PathBuf::from)
            .ok_or("payload path is required")?;
        let payload = fs::read(payload_path)?;
        println!("{}", STANDARD.encode(signing.sign(&payload).to_bytes()));
        return Ok(());
    }
    if command != "generate" {
        return Err("unknown command".into());
    }
    if path.exists() {
        return Err("refusing to overwrite an existing signing key".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let signing = SigningKey::generate(&mut OsRng);
    let verifying: VerifyingKey = signing.verifying_key();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(STANDARD.encode(signing.to_bytes()).as_bytes())?;
    file.write_all(b"\n")?;
    println!("public={}", STANDARD.encode(verifying.to_bytes()));
    println!("private_key_path={}", path.display());
    Ok(())
}
