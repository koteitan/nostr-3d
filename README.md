# nostr-3d

A nostr timeline viewer that places its columns in 3D space. It is an experiment with
[HTML-in-Canvas](https://developer.chrome.com/blog/html-in-canvas): every column is ordinary
DOM that the browser draws into a WebGL texture, and it stays interactive (clicks, scrolling,
text selection, links).

https://koteitan.github.io/nostr-3d/

## Usage

| operation | effect |
|---|---|
| drag the title bar | move the column |
| mouse wheel on the title bar | move the column nearer / farther |
| drag near one of the four corners | rotate the column around its centre |
| double click a note | open the note and its replies as a new column to the right of the note |
| `+` (top right) | choose a column to add: ⌚ follow timeline, 🌎 global timeline, 🔎 search |
| `🌙` (top right) | switch the light / dark theme |

- The first column is the timeline of the accounts you follow. The public key comes from a
  NIP-07 browser extension. Without one, the global timeline is shown.
- Search uses the NIP-50 relays `search.nos.today` and `relay.noswhere.com`.
- Relays: kind:10002 of your public key is looked up on the bootstrap relays
  (`directory.yabu.me`, `purplepag.es`, `user.kindpag.es`, `indexer.coracle.social`); if there is
  none, the relay list in kind:3; if there is none, `yabu.me`, `nostr-pub.wellorder.net` and
  `relay.snort.social`.

## Browser

HTML-in-Canvas shipped in Chrome 157. In other browsers the same scene is shown with CSS 3D
transforms instead (append `?mode=css3d` to the URL to see this mode in Chrome).

HTML-in-Canvas does not draw cross-origin content into a canvas, so inside the canvas:

- images and videos are loaded with `crossorigin="anonymous"`; those whose server does not allow
  CORS are shown as a link
- posts on X and YouTube videos are shown as cards made of their oEmbed data, not as iframes
  (the CSS 3D mode uses the usual iframe embeds)

## Development

```
npm install
npm run dev     # development server
npm run build   # type check and build into dist/
```

Stack: TypeScript, Vite, React, [rx-nostr](https://github.com/penpenpng/rx-nostr).

## Acknowledgements

The look of the timeline follows the nostr client [Rabbit](https://github.com/syusui-s/rabbit).
No code of Rabbit is included.

## License

MIT
