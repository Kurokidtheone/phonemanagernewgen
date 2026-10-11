// The outside route: one PhoneLink per paired phone, created on first use. Sealing, opening and the mailbox calls all
// live in @shared/remote (the same code the tests run against a fake Supabase). Requests are only ever sent to the
// Supabase project over https; the mailbox name and key never leave the phone except inside that encrypted traffic.
import { PhoneLink, type PhoneLinkOptions } from '@shared/remote';
import { NetworkError } from './http';
import type { SavedRemote } from './storage';

let deps: Partial<PhoneLinkOptions> = {};
/** Tests: a fake Supabase and short waits. */
export const setLinkDepsForTests = (next: Partial<PhoneLinkOptions> | null): void => {
  closeLinks();
  deps = next ?? {};
};

const links = new Map<string, PhoneLink>();

export function linkFor(remote: SavedRemote): PhoneLink {
  if (!/^https:\/\//.test(remote.url)) throw new NetworkError('cleartext_blocked');
  const id = `${remote.mailbox}:${remote.key}`;
  let link = links.get(id);
  if (!link) {
    link = new PhoneLink({
      config: { url: remote.url, anonKey: remote.anonKey },
      mailbox: remote.mailbox,
      key: remote.key,
      deviceId: remote.deviceId,
      socket: typeof WebSocket === 'undefined' ? undefined : (WebSocket as unknown as PhoneLinkOptions['socket']),
      ...deps,
    });
    links.set(id, link);
  }
  return link;
}

/** A one-off link for a pairing code: its mailbox is private to the code, and it is closed after use. */
export function pairingLink(channel: { mailbox: string; key: string }, config: { url: string; anonKey: string }, deviceId: string): PhoneLink {
  if (!/^https:\/\//.test(config.url)) throw new NetworkError('cleartext_blocked');
  return new PhoneLink({ config, mailbox: channel.mailbox, key: channel.key, deviceId, socket: typeof WebSocket === 'undefined' ? undefined : (WebSocket as unknown as PhoneLinkOptions['socket']), ...deps, timeoutMs: deps.timeoutMs ?? 45_000 });
}

export function closeLinks(): void {
  for (const link of links.values()) link.close();
  links.clear();
}
