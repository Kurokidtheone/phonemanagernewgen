//! The whole system on one phone: the same core as the desktop, with its data in the app's private folder, no phone
//! server, no Supabase, no sync. The Android app calls it through a Kotlin Capacitor plugin (JNI): JSON in, JSON out.
//!
//! The functions in `bridge` are plain Rust, so `cargo test` runs them on the host; `jni_glue` only wraps them for Android.

pub mod bridge;

#[cfg(target_os = "android")]
mod jni_glue;
