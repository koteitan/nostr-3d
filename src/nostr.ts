// The nostr side: relay discovery, the follow list and the feeds of the columns.
// Everything is pushed to the UI as it arrives; nothing waits for EOSE to render.

import { verifier } from '@rx-nostr/crypto';
import {
  createRxBackwardReq,
  createRxForwardReq,
  createRxNostr,
  uniq,
  type LazyFilter,
} from 'rx-nostr';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export const BOOTSTRAP_RELAYS = [
  'wss://directory.yabu.me',
  'wss://purplepag.es',
  'wss://user.kindpag.es',
  'wss://indexer.coracle.social',
];

export const DEFAULT_RELAYS = [
  'wss://yabu.me',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.snort.social',
];

/** relays that support search (NIP-50) */
export const SEARCH_RELAYS = ['wss://search.nos.today', 'wss://relay.noswhere.com'];

/** notes that each relay sends from its store when a timeline opens */
const INITIAL_NOTES = 30;
const MAX_AUTHORS_PER_FILTER = 1000;
const MAX_FUTURE_SECONDS = 600;

export const rxNostr = createRxNostr({ verifier });

// ------------------------------------------------------------------ stores

type Listener = () => void;

/** A sorted, de-duplicated list of notes that React can subscribe to. */
export class Feed {
  private events: NostrEvent[] = [];
  private ids = new Set<string>();
  private listeners = new Set<Listener>();
  private snapshot: NostrEvent[];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param order 'desc': newest first (timeline). 'asc': oldest first (replies).
   * @param pinned shown first regardless of the order (the root note of a thread).
   */
  constructor(
    private order: 'desc' | 'asc',
    private limit: number,
    private pinned?: NostrEvent,
  ) {
    if (pinned != null) this.ids.add(pinned.id);
    this.snapshot = pinned != null ? [pinned] : [];
  }

  add(ev: NostrEvent) {
    if (this.ids.has(ev.id)) return;
    // a note dated in the future would stay at the top of the timeline
    if (ev.created_at > Date.now() / 1000 + MAX_FUTURE_SECONDS) return;
    this.ids.add(ev.id);
    const before = (a: NostrEvent, b: NostrEvent) =>
      this.order === 'desc' ? a.created_at > b.created_at : a.created_at < b.created_at;
    let i = this.events.length;
    while (i > 0 && before(ev, this.events[i - 1])) i -= 1;
    this.events.splice(i, 0, ev);
    if (this.events.length > this.limit) {
      // a timeline drops its oldest notes; a thread keeps what arrived first
      const dropped = this.events.splice(this.limit);
      if (this.order === 'desc') dropped.forEach((d) => this.ids.delete(d.id));
    }
    // many notes arrive at once when a subscription opens: publish them together
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.snapshot = this.pinned != null ? [this.pinned, ...this.events] : [...this.events];
      this.listeners.forEach((l) => l());
    }, 50);
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
}

export interface NostrStatus {
  /** what the bootstrap is doing now, shown in the home column until notes arrive */
  stage: string;
  pubkey: string | null;
  relays: string[];
  relaySource: 'kind:10002' | 'kind:3' | 'default' | null;
  follows: number;
  /**
   * What a follow column shows. 'follow': notes of the follow list.
   * 'global': the global timeline, because there is no NIP-07 pubkey or no follow list.
   */
  timeline: 'follow' | 'global' | null;
}

let status: NostrStatus = {
  stage: 'NIP-07 拡張機能を待っています…',
  pubkey: null,
  relays: [],
  relaySource: null,
  follows: 0,
  timeline: null,
};
const statusListeners = new Set<Listener>();
const setStatus = (patch: Partial<NostrStatus>) => {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l());
};
export const subscribeStatus = (listener: Listener) => {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
};
export const getStatus = () => status;

/** the notes of the follow list (every follow column shows this feed) */
export const homeFeed = new Feed('desc', 100);
/** the notes of everybody on the relays of the user (every global column shows this feed) */
export const globalFeed = new Feed('desc', 100);
/** a feed that never gets a note */
export const EMPTY_FEED = new Feed('desc', 0);

let resolveRelaysReady: () => void = () => undefined;
/** resolved when the relays of the user are known */
const relaysReady = new Promise<void>((resolve) => {
  resolveRelaysReady = resolve;
});

// --------------------------------------------------------------- bootstrap

interface Nip07 {
  getPublicKey(): Promise<string>;
}

const getNip07Pubkey = async (): Promise<string | null> => {
  const nostr = () => (window as unknown as { nostr?: Nip07 }).nostr;
  // extensions inject window.nostr a little after the page starts
  for (let i = 0; i < 20 && nostr() == null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    const pubkey = await nostr()?.getPublicKey();
    return typeof pubkey === 'string' && /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null;
  } catch (err) {
    console.warn('NIP-07 getPublicKey failed', err);
    return null;
  }
};

/**
 * One backward request. Resolves when all relays sent EOSE (completed = true), when
 * `timeoutMs` passed, or `graceMs` after `onEvent` first returned true (a hit).
 */
const collect = (
  filter: LazyFilter,
  relays: string[],
  timeoutMs: number,
  onEvent: (ev: NostrEvent) => boolean,
  graceMs = 300,
): Promise<{ hit: boolean; completed: boolean }> =>
  new Promise((resolve) => {
    let hit = false;
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const req = createRxBackwardReq();
    const finish = (completed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      if (graceTimer != null) clearTimeout(graceTimer);
      queueMicrotask(() => subscription.unsubscribe());
      resolve({ hit, completed });
    };
    const timeoutTimer = setTimeout(() => finish(false), timeoutMs);
    const subscription = rxNostr
      .use(req, { on: { relays } })
      .pipe(uniq())
      .subscribe({
        next: (packet) => {
          if (onEvent(packet.event as NostrEvent) && !hit) {
            hit = true;
            graceTimer = setTimeout(() => finish(false), graceMs);
          }
        },
        complete: () => finish(true),
        error: () => finish(true),
      });
    req.emit(filter);
    req.over();
  });

/** 5 seconds first; if the relays did not all answer and nothing was found, 30 seconds more. */
const collectWithRetry = async (
  filter: LazyFilter,
  relays: string[],
  onEvent: (ev: NostrEvent) => boolean,
) => {
  const first = await collect(filter, relays, 5000, onEvent);
  if (first.hit || first.completed) return;
  await collect(filter, relays, 30000, onEvent);
};

const normalizeRelayUrl = (url: unknown): string | null => {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    return u.href.replace(/\/$/, '');
  } catch {
    return null;
  }
};

const uniqueRelays = (urls: (string | null)[]) => [...new Set(urls.filter((u) => u != null))];

/** kind:10002 "r" tags without the read-only ones */
const relaysFromRelayList = (ev: NostrEvent): string[] =>
  uniqueRelays(
    ev.tags.filter((t) => t[0] === 'r' && t[2] !== 'read').map((t) => normalizeRelayUrl(t[1])),
  );

/** the legacy relay map in the content of kind:3, without the read-only ones */
const relaysFromContacts = (ev: NostrEvent): string[] => {
  try {
    const map = JSON.parse(ev.content) as Record<string, { read?: boolean; write?: boolean }>;
    if (map == null || typeof map !== 'object') return [];
    return uniqueRelays(
      Object.entries(map)
        .filter(([, v]) => v?.write !== false)
        .map(([url]) => normalizeRelayUrl(url)),
    );
  } catch {
    return [];
  }
};

/** bootstrap relays -> kind:10002 -> kind:3 -> default relays */
const discoverRelays = async (
  pubkey: string,
): Promise<{ relays: string[]; source: NonNullable<NostrStatus['relaySource']> }> => {
  let relayList: NostrEvent | null = null;
  let contacts: NostrEvent | null = null;
  await collectWithRetry(
    { kinds: [10002, 3], authors: [pubkey], limit: 2 },
    BOOTSTRAP_RELAYS,
    (ev) => {
      if (ev.kind === 10002) {
        if (relayList == null || ev.created_at > relayList.created_at) relayList = ev;
        return true;
      }
      if (ev.kind === 3 && (contacts == null || ev.created_at > contacts.created_at)) contacts = ev;
      return false;
    },
  );
  if (relayList != null) {
    const relays = relaysFromRelayList(relayList);
    if (relays.length > 0) return { relays, source: 'kind:10002' };
  }
  if (contacts != null) {
    const relays = relaysFromContacts(contacts);
    if (relays.length > 0) return { relays, source: 'kind:3' };
  }
  return { relays: DEFAULT_RELAYS, source: 'default' };
};

const fetchFollows = async (pubkey: string, relays: string[]): Promise<string[]> => {
  let contacts: NostrEvent | null = null;
  await collectWithRetry(
    { kinds: [3], authors: [pubkey], limit: 1 },
    [...new Set([...relays, ...BOOTSTRAP_RELAYS])],
    (ev) => {
      if (ev.kind !== 3) return false;
      if (contacts == null || ev.created_at > contacts.created_at) contacts = ev;
      return true;
    },
  );
  const tags: string[][] = (contacts as NostrEvent | null)?.tags ?? [];
  return [
    ...new Set(tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1])),
  ];
};

let started = false;

/** NIP-07 pubkey -> relays -> follow list -> real-time subscription of the home feed */
export const startNostr = async () => {
  if (started) return;
  started = true;

  const pubkey = await getNip07Pubkey();
  setStatus({ pubkey, stage: 'リレーを探しています…' });

  const { relays, source } =
    pubkey != null
      ? await discoverRelays(pubkey)
      : { relays: DEFAULT_RELAYS, source: 'default' as const };
  rxNostr.setDefaultRelays(relays);
  resolveRelaysReady();
  setStatus({ relays, relaySource: source, stage: 'フォローリストを取得しています…' });

  const follows = pubkey != null ? await fetchFollows(pubkey, relays) : [];

  if (pubkey == null || follows.length === 0) {
    startGlobalFeed();
    setStatus({ follows: 0, timeline: 'global', stage: 'ノートを待っています…' });
    return;
  }

  const authors = [...new Set([pubkey, ...follows])];
  const filters: LazyFilter[] = [];
  for (let i = 0; i < authors.length; i += MAX_AUTHORS_PER_FILTER) {
    filters.push({
      kinds: [1],
      authors: authors.slice(i, i + MAX_AUTHORS_PER_FILTER),
      limit: INITIAL_NOTES,
    });
  }
  const req = createRxForwardReq();
  rxNostr
    .use(req)
    .pipe(uniq())
    .subscribe((packet) => homeFeed.add(packet.event as NostrEvent));
  req.emit(filters);
  setStatus({ follows: follows.length, timeline: 'follow', stage: 'ノートを待っています…' });
};

let globalStarted = false;

/** Starts the real-time subscription of the global timeline (once). */
export const startGlobalFeed = () => {
  if (globalStarted) return;
  globalStarted = true;
  void relaysReady.then(() => {
    const req = createRxForwardReq();
    rxNostr
      .use(req)
      .pipe(uniq())
      .subscribe((packet) => globalFeed.add(packet.event as NostrEvent));
    req.emit({ kinds: [1], limit: INITIAL_NOTES });
  });
};

/** Notes that match the query (NIP-50), updated in real time. */
export const openSearch = (query: string): { feed: Feed; close: () => void } => {
  const feed = new Feed('desc', 100);
  const req = createRxForwardReq();
  const subscription = rxNostr
    .use(req, { on: { relays: SEARCH_RELAYS } })
    .pipe(uniq())
    .subscribe((packet) => feed.add(packet.event as NostrEvent));
  req.emit({ kinds: [1], search: query, limit: INITIAL_NOTES });
  return { feed, close: () => subscription.unsubscribe() };
};

/** The note and its replies, updated in real time. */
export const openThread = (root: NostrEvent): { feed: Feed; close: () => void } => {
  const feed = new Feed('asc', 300, root);
  const req = createRxForwardReq();
  const subscription = rxNostr
    .use(req)
    .pipe(uniq())
    .subscribe((packet) => feed.add(packet.event as NostrEvent));
  req.emit({ kinds: [1], '#e': [root.id] });
  return { feed, close: () => subscription.unsubscribe() };
};
