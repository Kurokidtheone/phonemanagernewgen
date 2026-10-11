use wire::{Assembler, Sealed};

use crate::{Dir, Error, Mailbox};

/// What came out of the mailbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    /// A complete sealed message. `last_row` is the id of the newest row that
    /// made it up: pass it to [`Mailbox::ack`] once the message is handled.
    Message { sealed: Sealed, last_row: i64 },
    /// A body that is not a valid message. Count it, ack it, drop it.
    Bad { last_row: i64 },
}

impl Incoming {
    pub fn last_row(&self) -> i64 {
        match self {
            Incoming::Message { last_row, .. } | Incoming::Bad { last_row } => *last_row,
        }
    }
}

/// Reads one direction of one mailbox. Remembers the newest row it has seen, so
/// rows that are fetched but not yet acked are not returned twice.
pub struct Inbox {
    mb: Mailbox,
    mailbox: String,
    dir: Dir,
    cursor: i64,
    assembler: Assembler,
}

impl Inbox {
    pub fn new(mb: Mailbox, mailbox: &str, dir: Dir) -> Self {
        Self {
            mb,
            mailbox: mailbox.to_string(),
            dir,
            cursor: 0,
            assembler: Assembler::new(),
        }
    }

    /// Fetch everything waiting (more than one page if needed), in order.
    pub async fn poll(&mut self) -> Result<Vec<Incoming>, Error> {
        let mut out = Vec::new();
        loop {
            let rows = self.mb.fetch(&self.mailbox, self.dir, self.cursor).await?;
            let n = rows.len();
            for row in rows {
                self.cursor = self.cursor.max(row.id);
                match self.assembler.push(&row.body) {
                    Ok(Some((_, sealed))) => out.push(Incoming::Message {
                        sealed,
                        last_row: row.id,
                    }),
                    Ok(None) => {}
                    Err(_) => out.push(Incoming::Bad { last_row: row.id }),
                }
            }
            if n < 50 {
                return Ok(out);
            }
        }
    }

    /// Ack up to a row id (delivered rows are deleted on the server).
    pub async fn ack(&self, up_to: i64) -> Result<(), Error> {
        self.mb.ack(&self.mailbox, self.dir, up_to).await
    }

    /// Forget the cursor and half-received messages (after a long pause).
    pub fn reset(&mut self) {
        self.cursor = 0;
        self.assembler.clear();
    }
}

/// Send a sealed message, splitting it into parts when needed. Returns the id
/// of the last row.
pub async fn send_sealed(
    mb: &Mailbox,
    mailbox: &str,
    dir: Dir,
    message_id: &str,
    sealed: &Sealed,
) -> Result<i64, Error> {
    let bodies = wire::pack(message_id, sealed).map_err(|_| Error::TooLarge)?;
    let mut last = 0;
    for b in bodies {
        last = mb.send(mailbox, dir, &b).await?;
    }
    Ok(last)
}
