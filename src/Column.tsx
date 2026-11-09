import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { ColumnContext, Mention, NoteContent, shortNpub } from './content';
import { getStatus, homeFeed, subscribeStatus, type Feed, type NostrEvent } from './nostr';
import { useProfile } from './profiles';
import { scene } from './scene';

export type ColumnDef =
  | { id: number; kind: 'home' }
  | { id: number; kind: 'thread'; root: NostrEvent; feed: Feed; close: () => void };

/** the element is drawn into the canvas (ignored outside of <canvas content="drawable">) */
const drawable = { drawable: '' } as object;

const formatTime = (createdAt: number): string => {
  const date = new Date(createdAt * 1000);
  const now = new Date();
  const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return time;
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}/${day} ${time}`;
};

const Avatar = ({ pubkey, picture }: { pubkey: string; picture?: string }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    // the colour made of the pubkey is seen while there is no picture
    <div className="note-icon" style={{ backgroundColor: `#${pubkey.slice(0, 6)}` }}>
      {picture != null && picture !== failedUrl && (
        <img
          src={picture}
          alt=""
          referrerPolicy="no-referrer"
          crossOrigin={scene.mode === 'drawable' ? 'anonymous' : undefined}
          onError={() => setFailedUrl(picture)}
        />
      )}
    </div>
  );
};

interface NoteProps {
  event: NostrEvent;
  onOpen: (event: NostrEvent, el: HTMLElement) => void;
}

const Note = memo(({ event, onOpen }: NoteProps) => {
  const profile = useProfile(event.pubkey);
  const warning = event.tags.find((t) => t[0] === 'content-warning');
  const [revealed, setRevealed] = useState(false);
  const replyTo = [...new Set(event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]))];

  return (
    <div
      className="note"
      onDoubleClick={(ev) => {
        if ((ev.target as Element).closest('a, button, video, iframe') != null) return;
        window.getSelection()?.removeAllRanges();
        onOpen(event, ev.currentTarget);
      }}
    >
      <Avatar pubkey={event.pubkey} picture={profile?.picture} />
      <div className="note-main">
        <div className="note-head">
          <div className="author">
            {profile?.display_name != null && (
              <span className="author-name">{profile.display_name}</span>
            )}
            <span className="author-username">@{profile?.name ?? shortNpub(event.pubkey)}</span>
          </div>
          <span className="created-at" title={new Date(event.created_at * 1000).toLocaleString()}>
            {formatTime(event.created_at)}
          </span>
        </div>
        {replyTo.length > 0 && (
          <div className="reply-to">
            {replyTo.slice(0, 3).map((pubkey) => (
              <Mention key={pubkey} pubkey={pubkey} />
            ))}
            {replyTo.length > 3 && <span>ほか{replyTo.length - 3}人</span>}
            <span>への返信</span>
          </div>
        )}
        {warning != null && !revealed ? (
          <button className="content-warning" onClick={() => setRevealed(true)}>
            ⚠ 表示するにはクリック{warning[1] ? ` (${warning[1]})` : ''}
          </button>
        ) : (
          <div className="note-content">
            <NoteContent event={event} />
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Calls onMove with the pointer movement until the button is released.
 * The listeners are on the window: the pointer leaves the element while dragging.
 */
const drag = (
  ev: ReactPointerEvent,
  onMove: (x: number, y: number, prevX: number, prevY: number) => void,
) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const pointerId = ev.pointerId;
  const target = ev.currentTarget;
  let prevX = ev.clientX;
  let prevY = ev.clientY;
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    onMove(e.clientX, e.clientY, prevX, prevY);
    prevX = e.clientX;
    prevY = e.clientY;
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    target.classList.remove('dragging');
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  target.classList.add('dragging');
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // the window listeners still follow the pointer
  }
};

interface ColumnProps {
  def: ColumnDef;
  onClose: (id: number) => void;
  onOpenThread: (sourceId: number, event: NostrEvent, noteEl: HTMLElement) => void;
}

export const Column = memo(({ def, onClose, onOpenThread }: ColumnProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const { id } = def;
  const feed = def.kind === 'home' ? homeFeed : def.feed;
  const notes = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const status = useSyncExternalStore(subscribeStatus, getStatus);

  useLayoutEffect(() => scene.register(id, ref.current!), [id]);

  const openNote = useCallback(
    (event: NostrEvent, el: HTMLElement) => onOpenThread(id, event, el),
    [id, onOpenThread],
  );

  const startMove = (ev: ReactPointerEvent) => {
    if ((ev.target as Element).closest('button') != null) return;
    drag(ev, (x, y, prevX, prevY) => scene.moveBy(id, x - prevX, y - prevY));
  };

  const startRotate = (ev: ReactPointerEvent) => {
    const center = scene.screenCenter(id);
    // the grabbed corner starts inside the trackball, where it follows the pointer
    const radius = Math.max(120, 1.25 * Math.hypot(ev.clientX - center.x, ev.clientY - center.y));
    drag(ev, (x, y, prevX, prevY) => scene.rotateArc(id, center, radius, prevX, prevY, x, y));
  };

  const title =
    def.kind === 'thread'
      ? '💬 スレッド'
      : status.timeline === 'global'
        ? '🌐 グローバル'
        : '🏠 ホーム';

  return (
    <ColumnContext.Provider value={id}>
      <div ref={ref} className="column" {...drawable} onPointerDownCapture={() => scene.raise(id)}>
        <div
          className="col-title"
          onPointerDown={startMove}
          onWheel={(ev) => scene.dolly(id, -ev.deltaY)}
        >
          <span className="col-name">{title}</span>
          <button className="col-close" title="カラムを閉じる" onClick={() => onClose(id)}>
            ×
          </button>
        </div>
        <div className="col-body">
          {def.kind === 'home' && notes.length === 0 && (
            <div className="col-status">{status.stage}</div>
          )}
          {def.kind === 'home' && status.timeline === 'global' && (
            <div className="col-status">
              {status.pubkey == null
                ? 'NIP-07 の公開鍵が取得できないため、グローバルタイムラインを表示しています。'
                : 'フォローリストが見つからないため、グローバルタイムラインを表示しています。'}
            </div>
          )}
          {notes.map((event) => (
            <Note key={event.id} event={event} onOpen={openNote} />
          ))}
        </div>
        {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
          <div
            key={corner}
            className={`corner corner-${corner}`}
            title="ドラッグで回転"
            onPointerDown={startRotate}
          />
        ))}
      </div>
    </ColumnContext.Provider>
  );
});
