// The content of a note: text, links, mentions, custom emoji and embedded media.
//
// HTML-in-Canvas does not paint cross-origin content into the canvas unless it is
// CORS-approved, and it never paints cross-origin iframes. Therefore, inside the canvas:
//   - images and videos are requested with crossorigin="anonymous"
//   - posts on X and YouTube videos, which are iframes in a normal page, are shown as
//     cards built from their oEmbed data
// In the CSS 3D fallback the usual iframe embeds are used.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';

import { decodeNip19, npubEncode } from './nip19';
import { type NostrEvent } from './nostr';
import { useProfile } from './profiles';
import { scene } from './scene';

const inCanvas = scene.mode === 'drawable';
const cors = inCanvas ? ({ crossOrigin: 'anonymous' } as const) : {};

/** the id of the column that the component is in */
export const ColumnContext = createContext(0);

// ------------------------------------------------------------------- links

const openInNewTab = { target: '_blank', rel: 'noreferrer noopener' } as const;

const Link = ({ url, children }: { url: string; children?: ReactNode }) => (
  <a className="link" href={url} {...openInNewTab}>
    {children ?? url}
  </a>
);

export const shortNpub = (pubkey: string) => `${npubEncode(pubkey).slice(0, 12)}…`;

export const Mention = ({ pubkey }: { pubkey: string }) => {
  const profile = useProfile(pubkey);
  return (
    <span className="link">@{profile?.name ?? profile?.display_name ?? shortNpub(pubkey)}</span>
  );
};

// ------------------------------------------------------------------- media

const ImageEmbed = ({ url }: { url: string }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <>
        <Link url={url} />
        {inCanvas && <span className="hint"> (CORS 非対応の画像は canvas に描画できません)</span>}
      </>
    );
  }
  return (
    <a className="media" href={url} {...openInNewTab}>
      <img
        className="media-image"
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        {...cors}
        onError={() => setFailed(true)}
      />
    </a>
  );
};

const VideoEmbed = ({ url }: { url: string }) => {
  const columnId = useContext(ColumnContext);
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);

  // while the video plays, the picture of the column in the canvas follows the frames
  useEffect(() => {
    const video = ref.current;
    if (video == null || !playing) return undefined;
    scene.startAnimating(video, columnId);
    return () => scene.stopAnimating(video);
  }, [playing, columnId]);

  if (failed) {
    return (
      <>
        <Link url={url} />
        {inCanvas && <span className="hint"> (CORS 非対応の動画は canvas に描画できません)</span>}
      </>
    );
  }

  const toggle = (ev: SyntheticEvent) => {
    // the controls of a video are not painted into the canvas: a click plays / pauses
    if (!inCanvas) return;
    ev.preventDefault();
    const video = ref.current;
    if (video == null) return;
    if (video.paused) void video.play().catch(() => setFailed(true));
    else video.pause();
  };

  return (
    <span className="media media-video">
      <video
        ref={ref}
        className="media-image"
        src={url}
        preload="metadata"
        playsInline
        controls={!inCanvas}
        {...cors}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
      />
      {inCanvas && !playing && (
        <span className="play-badge" onClick={toggle}>
          ▶
        </span>
      )}
    </span>
  );
};

// --------------------------------------------------------- posts on X

interface Tweet {
  author: string;
  handle: string;
  text: string;
  date: string;
}

const tweets = new Map<string, Promise<Tweet | null>>();

const fetchTweet = (url: string): Promise<Tweet | null> => {
  let promise = tweets.get(url);
  if (promise == null) {
    promise = (async () => {
      try {
        const endpoint = new URL('https://publish.x.com/oembed');
        endpoint.search = new URLSearchParams({ url, omit_script: '1', dnt: 'true' }).toString();
        const res = await fetch(endpoint, { credentials: 'omit' });
        if (!res.ok) return null;
        const data = (await res.json()) as { html?: string; author_name?: string; author_url?: string };
        // the html is only parsed (never inserted): the text of the post is taken out of it
        const doc = new DOMParser().parseFromString(data.html ?? '', 'text/html');
        const paragraph = doc.querySelector('blockquote > p');
        if (paragraph == null) return null;
        const text = [...paragraph.childNodes]
          .map((node) => (node.nodeName === 'BR' ? '\n' : (node.textContent ?? '')))
          .join('');
        const dateLink = [...doc.querySelectorAll('blockquote > a')].pop();
        return {
          author: data.author_name ?? '',
          handle: (data.author_url ?? '').split('/').pop() ?? '',
          text,
          date: dateLink?.textContent ?? '',
        };
      } catch {
        return null;
      }
    })();
    tweets.set(url, promise);
  }
  return promise;
};

/** Inside the canvas: a card made of the oEmbed data of the post. */
const TweetCard = ({ url }: { url: string }) => {
  const [tweet, setTweet] = useState<Tweet | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchTweet(url).then((t) => {
      if (alive) setTweet(t);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return (
    <>
      <Link url={url} />
      {tweet != null && (
        <a className="embed-card" href={url} {...openInNewTab}>
          <span className="embed-site">
            𝕏 <b>{tweet.author}</b> @{tweet.handle}
          </span>
          <span className="embed-text">{tweet.text}</span>
          <span className="embed-site">{tweet.date}</span>
        </a>
      )}
    </>
  );
};

interface TwitterWidgets {
  widgets?: { load(el?: HTMLElement): void };
}
let twitterWidgets: Promise<void> | null = null;
const loadTwitterWidgets = () => {
  twitterWidgets ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://platform.twitter.com/widgets.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.append(script);
  });
  return twitterWidgets;
};

/** Outside the canvas: the embedded post of X (its widget turns the blockquote into an iframe). */
const TweetWidget = ({ url }: { url: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current;
    if (container == null) return undefined;
    // The widget replaces the blockquote with its own nodes, so React must not manage them.
    const quote = document.createElement('blockquote');
    quote.className = 'twitter-tweet';
    quote.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    quote.dataset.dnt = 'true';
    const anchor = document.createElement('a');
    anchor.href = url;
    quote.append(anchor);
    container.replaceChildren(quote);
    loadTwitterWidgets()
      .then(() => (window as unknown as { twttr?: TwitterWidgets }).twttr?.widgets?.load(container))
      .catch(() => undefined);
    return () => container.replaceChildren();
  }, [url]);
  return (
    <>
      <Link url={url} />
      <div ref={ref} />
    </>
  );
};

// ----------------------------------------------------------------- YouTube

const youtubeTitles = new Map<string, Promise<string | null>>();

const fetchYouTubeTitle = (videoId: string): Promise<string | null> => {
  let promise = youtubeTitles.get(videoId);
  if (promise == null) {
    promise = (async () => {
      try {
        const endpoint = new URL('https://www.youtube.com/oembed');
        endpoint.search = new URLSearchParams({
          url: `https://www.youtube.com/watch?v=${videoId}`,
          format: 'json',
        }).toString();
        const res = await fetch(endpoint, { credentials: 'omit' });
        if (!res.ok) return null;
        return ((await res.json()) as { title?: string }).title ?? null;
      } catch {
        return null;
      }
    })();
    youtubeTitles.set(videoId, promise);
  }
  return promise;
};

const YouTubeEmbed = ({ url, videoId }: { url: string; videoId: string }) => {
  const [title, setTitle] = useState<string | null>(null);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  useEffect(() => {
    if (!inCanvas) return undefined;
    let alive = true;
    void fetchYouTubeTitle(videoId).then((t) => {
      if (alive) setTitle(t);
    });
    return () => {
      alive = false;
    };
  }, [videoId]);

  if (!inCanvas) {
    const src = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
    src.searchParams.set('origin', window.location.origin);
    return (
      <>
        <Link url={url} />
        <iframe className="embed-frame" title="YouTube" src={src.href} allowFullScreen />
      </>
    );
  }
  return (
    <>
      <Link url={url} />
      <a className="embed-card" href={url} {...openInNewTab}>
        {!thumbnailFailed && (
          <span className="media media-video">
            <img
              className="embed-thumbnail"
              src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
              alt=""
              {...cors}
              onError={() => setThumbnailFailed(true)}
            />
            <span className="play-badge">▶</span>
          </span>
        )}
        <span className="embed-site">YouTube</span>
        {title != null && <span className="embed-text">{title}</span>}
      </a>
    </>
  );
};

// ------------------------------------------------------- classifying URLs

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'apng', 'svg']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv']);

const youtubeVideoId = (u: URL): string | null => {
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const valid = (id: string | null | undefined) =>
    id != null && /^[\w-]{6,}$/.test(id) ? id : null;
  if (host === 'youtu.be') return valid(u.pathname.split('/')[1]);
  if (host !== 'youtube.com') return null;
  if (u.pathname === '/watch') return valid(u.searchParams.get('v'));
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/);
  return valid(m?.[1]);
};

const UrlEmbed = ({ url }: { url: string }) => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return <>{url}</>;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return <>{url}</>;
  if (u.protocol === 'https:') {
    const extension = u.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    if (IMAGE_EXTENSIONS.has(extension)) return <ImageEmbed url={url} />;
    if (VIDEO_EXTENSIONS.has(extension)) return <VideoEmbed url={url} />;
    const host = u.hostname.replace(/^(www|mobile)\./, '');
    if ((host === 'twitter.com' || host === 'x.com') && /^\/\w+\/status\/\d+/.test(u.pathname)) {
      // the embed of X wants the twitter.com form of the address
      const canonical = `https://twitter.com${u.pathname}`;
      return inCanvas ? <TweetCard url={canonical} /> : <TweetWidget url={canonical} />;
    }
    const videoId = youtubeVideoId(u);
    if (videoId != null) return <YouTubeEmbed url={url} videoId={videoId} />;
  }
  return <Link url={url} />;
};

// ------------------------------------------------------------ custom emoji

const CustomEmoji = ({ shortcode, url }: { shortcode: string; url: string }) => {
  const [failed, setFailed] = useState(false);
  if (failed) return <>:{shortcode}:</>;
  return (
    <img
      className="emoji"
      src={url}
      alt={`:${shortcode}:`}
      title={shortcode}
      referrerPolicy="no-referrer"
      {...cors}
      onError={() => setFailed(true)}
    />
  );
};

// ---------------------------------------------------------------- parsing

// 1: URL (the characters that RFC 3986 allows)  2: NIP-19 entity  3: :shortcode:  4: #hashtag
const TOKEN =
  /(https?:\/\/[\w\-.~:/?#[\]@!$&'()*+,;=%]+)|(?:nostr:)?((?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]{20,})|:([\w+-]+):|(?<=^|\s)(#[^\s#!-/:-@[-`{-~、。「」（）]+)/gu;

/** Punctuation right after a URL belongs to the sentence, not to the URL. */
const splitTrailingPunctuation = (url: string): [string, string] => {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if ('.,;:!?\'"'.includes(c) || (c === ')' && !url.slice(0, end).includes('('))) end -= 1;
    else break;
  }
  return [url.slice(0, end), url.slice(end)];
};

export const NoteContent = ({ event }: { event: NostrEvent }) => {
  const emojis = new Map(
    event.tags.filter((t) => t[0] === 'emoji' && t[1] && t[2]).map((t) => [t[1], t[2]]),
  );
  const nodes: ReactNode[] = [];
  const { content } = event;
  let last = 0;
  for (const match of content.matchAll(TOKEN)) {
    const index = match.index;
    let node: ReactNode = null;
    let rest = '';
    if (match[1] != null) {
      const [url, trailing] = splitTrailingPunctuation(match[1]);
      rest = trailing;
      node = <UrlEmbed key={index} url={url} />;
    } else if (match[2] != null) {
      const entity = decodeNip19(match[2]);
      if (entity?.type === 'npub' || entity?.type === 'nprofile') {
        node = <Mention key={index} pubkey={entity.pubkey} />;
      } else if (entity != null) {
        node = (
          <span key={index} className="link">
            {match[2].slice(0, 16)}…
          </span>
        );
      }
    } else if (match[3] != null) {
      const url = emojis.get(match[3]);
      if (url != null) node = <CustomEmoji key={index} shortcode={match[3]} url={url} />;
    } else if (match[4] != null) {
      node = (
        <span key={index} className="link">
          {match[4]}
        </span>
      );
    }
    if (node == null) continue; // not a token after all: it stays in the text
    if (index > last) nodes.push(content.slice(last, index));
    nodes.push(node);
    if (rest !== '') nodes.push(rest);
    last = index + match[0].length;
  }
  if (last < content.length) nodes.push(content.slice(last));
  return <>{nodes}</>;
};
