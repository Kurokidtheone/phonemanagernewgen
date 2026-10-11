//! Prints a message sealed by the Rust crate, for the cross-language test vectors in wire/vectors.json.
use wire::*;

fn main() {
    let key = new_key();
    let mailbox = new_mailbox();
    let plain = r#"{"id":"r1","ts":1700000000000,"method":"POST","path":"/api/units.list","body":{"q":"é"}}"#.as_bytes();
    let s = seal(&key, &mailbox, "device-1", plain).unwrap();
    println!(
        "{}",
        serde_json::json!({"key": key_to_string(&key), "mailbox": mailbox, "device": "device-1",
            "plain": std::str::from_utf8(plain).unwrap(), "sealed": s})
    );
}
