import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { Column, type ColumnDef } from './Column';
import { quatFromAxisAngle, quatMul } from './mat4';
import { getStatus, openThread, subscribeStatus, type NostrEvent } from './nostr';
import { scene } from './scene';

type Theme = 'light' | 'dark';

const THEME_KEY = 'nostr-3d:theme';
/** space between a note and the thread column that opens to its right */
const THREAD_GAP = 16;

let nextId = 1;

const tilt = (yaw: number, pitch: number) =>
  quatMul(quatFromAxisAngle([0, 1, 0], yaw), quatFromAxisAngle([1, 0, 0], pitch));

// The first column is the follow timeline.
const firstColumn: ColumnDef = { id: nextId++, kind: 'follow' };
scene.setPose(firstColumn.id, { pos: [-200, 0, 0], rot: tilt(0.35, -0.06) });

const readTheme = (): Theme => {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

export const App = () => {
  const [columns, setColumns] = useState<ColumnDef[]>([firstColumn]);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const stageRef = useRef<HTMLElement | null>(null);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const status = useSyncExternalStore(subscribeStatus, getStatus);

  useLayoutEffect(() => {
    scene.onError = (message) => {
      console.error(message);
      setError(message);
    };
    const stage = stageRef.current!;
    scene.attach(stage);
    // Chrome does not reliably scroll a list with the mouse wheel when the list is drawn in
    // the canvas or has a perspective transform (the wheel event arrives, nothing scrolls).
    // So the wheel is handled here: a listener that is not passive, on the whole stage.
    const onWheel = (ev: WheelEvent) => {
      const body = (ev.target as Element).closest?.('.col-body');
      if (body == null || ev.ctrlKey || !ev.cancelable) return;
      ev.preventDefault();
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? body.clientHeight : 1;
      body.scrollTop += ev.deltaY * unit;
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stage.removeEventListener('wheel', onWheel);
      scene.detach();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // the theme is not remembered
    }
  }, [theme]);

  /** + menu: one more column, to the right of the rightmost column */
  const addColumn = (kind: 'follow' | 'global' | 'search') => {
    setMenuOpen(false);
    const id = nextId++;
    const poses = columns.map((c) => scene.getPose(c.id)).filter((p) => p != null);
    const rightmost = poses.reduce<number | null>(
      (max, p) => (max == null || p.pos[0] > max ? p.pos[0] : max),
      null,
    );
    const limit = window.innerWidth / 2 - 180;
    let x = rightmost == null ? 0 : rightmost + 380;
    let z = 0;
    if (x > limit) {
      // no room on the right: in front of the others, a little off the centre
      x = ((id * 70) % 400) - 200;
      z = 80;
    }
    scene.setPose(id, { pos: [x, 0, z], rot: tilt(id % 2 === 0 ? -0.3 : 0.3, 0.04) });
    setColumns((current) => [...current, { id, kind }]);
  };

  const closeColumn = useCallback((id: number) => {
    const def = columnsRef.current.find((c) => c.id === id);
    if (def?.kind === 'thread') def.close();
    setColumns((current) => current.filter((c) => c.id !== id));
    scene.forget(id);
  }, []);

  /** double click on a note: the note and its replies as a new column to the right of the note */
  const openThreadColumn = useCallback(
    (sourceId: number, event: NostrEvent, noteEl: HTMLElement) => {
      const body = noteEl.offsetParent as HTMLElement | null;
      const column = body?.parentElement;
      if (body == null || column == null) return;
      // The root note is the first note of the new column. Shifting the new column down by
      // the distance of the clicked note from the top of its list puts the two side by side.
      const down = noteEl.offsetTop - body.scrollTop;
      const id = nextId++;
      scene.setPose(id, scene.offsetPose(sourceId, column.offsetWidth + THREAD_GAP, down));
      const { feed, close } = openThread(event);
      setColumns((current) => [...current, { id, kind: 'thread', root: event, feed, close }]);
    },
    [],
  );

  const children = columns.map((def) => (
    <Column key={def.id} def={def} onClose={closeColumn} onOpenThread={openThreadColumn} />
  ));

  return (
    <>
      {scene.mode === 'drawable' ? (
        <canvas
          ref={(el) => {
            stageRef.current = el;
          }}
          className="stage"
          {...({ content: 'drawable' } as object)}
        >
          {children}
        </canvas>
      ) : (
        <div
          ref={(el) => {
            stageRef.current = el;
          }}
          className="stage"
        >
          {children}
        </div>
      )}

      <div className="panel">
        <div className="panel-row">
          {menuOpen && (
            <>
              <button title="フォロータイムライン" onClick={() => addColumn('follow')}>
                ⌚
              </button>
              <button title="グローバルタイムライン" onClick={() => addColumn('global')}>
                🌎
              </button>
              <button title="検索" onClick={() => addColumn('search')}>
                🔎
              </button>
            </>
          )}
          <button
            className={menuOpen ? 'panel-add open' : 'panel-add'}
            title="カラムを追加"
            onClick={() => setMenuOpen((open) => !open)}
          >
            +
          </button>
        </div>
        <button
          title="テーマ変更"
          onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
      </div>

      <div className="hud">
        <div>
          {scene.mode === 'drawable'
            ? 'HTML-in-Canvas (WebGL)'
            : 'CSS 3D で表示中 (このブラウザは HTML-in-Canvas 非対応、または ?mode=css3d)'}
        </div>
        <div>
          リレー {status.relays.length}
          {status.relaySource != null && ` (${status.relaySource})`} / フォロー {status.follows}
        </div>
        {error != null && <div className="hud-error">{error}</div>}
      </div>
    </>
  );
};
