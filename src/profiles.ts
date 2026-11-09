// The kind:0 collector. It is independent of the timelines: notes only ask for a pubkey
// and read the cache. Requests are batched, the newest kind:0 per pubkey wins, and the
// result (name, display_name, picture) is kept in localStorage across reloads.

import { createRxBackwardReq, uniq } from 'rx-nostr';
import { useEffect, useSyncExternalStore } from 'react';

import { BOOTSTRAP_RELAYS, rxNostr, type NostrEvent } from './nostr';

export interface Profile {
  name?: string;
  display_name?: string;
  picture?: string;
  /** created_at of the kind:0 event */
  created_at: number;
  /** when this entry was fetched (ms) */
  fetched_at: number;
}

const STORAGE_KEY = 'nostr-3d:profiles';
const MAX_STORED = 2000;
const STALE_MS = 6 * 60 * 60 * 1000;
const BATCH_DELAY_MS = 400;
const BATCH_SIZE = 200;

const cache = new Map<string, Profile>();
const listeners = new Map<string, Set<() => void>>();
/** pubkeys that were already queued in this session */
const requested = new Set<string>();
let queue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

try {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Profile>;
  Object.entries(stored).forEach(([pubkey, profile]) => cache.set(pubkey, profile));
} catch {
  // no cache: everything is fetched again
}

const save = () => {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    const newest = [...cache.entries()]
      .sort((a, b) => b[1].fetched_at - a[1].fetched_at)
      .slice(0, MAX_STORED);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
    } catch {
      // storage full or unavailable: the cache still works in memory
    }
  }, 3000);
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const accept = (ev: NostrEvent) => {
  const current = cache.get(ev.pubkey);
  if (current != null && current.created_at >= ev.created_at) return;
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(ev.content) as Record<string, unknown>;
  } catch {
    return;
  }
  if (content == null || typeof content !== 'object') return;
  cache.set(ev.pubkey, {
    name: text(content.name),
    display_name: text(content.display_name),
    picture: text(content.picture),
    created_at: ev.created_at,
    fetched_at: Date.now(),
  });
  listeners.get(ev.pubkey)?.forEach((l) => l());
  save();
};

const flush = () => {
  flushTimer = null;
  const pubkeys = queue;
  queue = [];
  for (let i = 0; i < pubkeys.length; i += BATCH_SIZE) {
    const authors = pubkeys.slice(i, i + BATCH_SIZE);
    const req = createRxBackwardReq();
    // the relays of the user and the indexer relays, which keep kind:0 of most users
    rxNostr
      .use(req, { on: { relays: BOOTSTRAP_RELAYS, defaultReadRelays: true } })
      .pipe(uniq())
      .subscribe((packet) => accept(packet.event as NostrEvent));
    req.emit({ kinds: [0], authors, limit: authors.length });
    req.over();
  }
};

/** Asks the collector for the profile. A cached profile is refreshed when it is old. */
export const requestProfile = (pubkey: string) => {
  if (requested.has(pubkey)) return;
  requested.add(pubkey);
  const cached = cache.get(pubkey);
  if (cached != null && Date.now() - cached.fetched_at < STALE_MS) return;
  queue.push(pubkey);
  flushTimer ??= setTimeout(flush, BATCH_DELAY_MS);
};

export const getProfile = (pubkey: string): Profile | undefined => cache.get(pubkey);

const subscribeProfile = (pubkey: string, listener: () => void) => {
  let set = listeners.get(pubkey);
  if (set == null) {
    set = new Set();
    listeners.set(pubkey, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(pubkey);
  };
};

export const useProfile = (pubkey: string): Profile | undefined => {
  useEffect(() => requestProfile(pubkey), [pubkey]);
  return useSyncExternalStore(
    (listener) => subscribeProfile(pubkey, listener),
    () => cache.get(pubkey),
  );
};
