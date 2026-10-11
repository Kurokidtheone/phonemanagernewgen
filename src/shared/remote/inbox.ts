import { type Dir, type Mailbox, RemoteError } from './client';
import { Assembler, pack, type Sealed, WireError } from './wire';

export type Incoming = { kind: 'message'; sealed: Sealed; lastRow: number } | { kind: 'bad'; lastRow: number };

/**
 * Reads one direction of one mailbox. It remembers the newest row it has seen, so rows that were fetched but not yet
 * acked are not returned twice. Ack with the `lastRow` of a message once it is handled.
 */
export class Inbox {
  private cursor = 0;
  private assembler = new Assembler();
  constructor(
    private mb: Mailbox,
    private mailbox: string,
    private dir: Dir,
  ) {}

  async poll(): Promise<Incoming[]> {
    const out: Incoming[] = [];
    for (;;) {
      const rows = await this.mb.fetch(this.mailbox, this.dir, this.cursor);
      for (const row of rows) {
        this.cursor = Math.max(this.cursor, row.id);
        try {
          const sealed = this.assembler.push(row.body);
          if (sealed) out.push({ kind: 'message', sealed, lastRow: row.id });
        } catch {
          out.push({ kind: 'bad', lastRow: row.id });
        }
      }
      if (rows.length < 50) return out;
    }
  }

  ack(upTo: number): Promise<void> {
    return this.mb.ack(this.mailbox, this.dir, upTo);
  }
}

/** Sends one sealed message, split into parts when long. Returns the id of the last row. */
export async function sendSealed(mb: Mailbox, mailbox: string, dir: Dir, messageId: string, sealed: Sealed): Promise<number> {
  let bodies: string[];
  try {
    bodies = pack(messageId, sealed);
  } catch (err) {
    if (err instanceof WireError) throw new RemoteError('body_too_large');
    throw err;
  }
  let last = 0;
  for (const body of bodies) last = await mb.send(mailbox, dir, body);
  return last;
}
