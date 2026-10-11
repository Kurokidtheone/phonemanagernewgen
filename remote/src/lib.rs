//! Client for the Supabase mailbox used for outside access.
//!
//! * [`Mailbox`] calls the five `mb_*` functions over HTTPS with the anon key.
//! * [`WakeListener`] keeps one Realtime WebSocket open and signals a
//!   [`tokio::sync::Notify`] on every wake-up. Wake-ups are only a hint:
//!   everything also works by polling [`Mailbox::fetch`], so a lost socket
//!   never loses a message.
//! * [`Inbox`] fetches one direction of a mailbox and joins split messages.

mod client;
mod inbox;
mod wake;

#[cfg(feature = "fake")]
pub mod fake;

pub use client::{Config, Dir, Error, Mailbox, Row};
pub use inbox::{send_sealed, Inbox, Incoming};
pub use wake::{Backoff, WakeListener};

pub(crate) fn install_tls() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}
