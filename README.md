# TizenSpotify

Ad-free Spotify on your Samsung TV, controlled from your iPhone.

Built on [TizenBrew](https://github.com/reisxd/TizenBrew) — a modular app launcher that runs on Samsung Tizen TVs. This module loads Spotify's web player directly in the TV's browser, blocks and skips ads, and lets your iPhone act as a touch remote over WebSocket.

## iPhone Remote

**[https://unboundangel.github.io/Tizenfy/main.html](https://unboundangel.github.io/Tizenfy/main.html)**

Open that link on your phone — it's the remote control for Spotify on your TV. Connect to your TV's IP and it works over WebSocket on your local network. Add to home screen from Safari for a native app feel.

---

## How it works

Three pieces talk to each other:

**`service.js`** runs as a background Node.js process on the TV via TizenBrew. It's a WebSocket server on port 8765 that sits between the TV and your phone.

**`userScript.js`** gets injected into `open.spotify.com` when it loads on the TV. It connects to `service.js` and handles ads in three layers: network requests to known ad-delivery endpoints are intercepted and blocked, detected ads are immediately muted then auto-skipped after 300 ms, and ad UI elements are hidden via CSS.

**`main.html`** is the iPhone remote — visit [https://unboundangel.github.io/Tizenfy/main.html](https://unboundangel.github.io/Tizenfy/main.html) on your phone. Type the TV's IP, hit connect, and you've got a full playback remote. Add it to your home screen from Safari to use it like a native app.

---

## Ad blocking

Ads are handled in three layers (inspired by [adblockify](https://github.com/CharlieS1103/spicetify-marketplace)):

1. **Network interception** — `fetch` and `XHR` are overridden to intercept requests to known Spotify ad-delivery endpoints before any ad audio loads
2. **Auto-skip** — when an ad is detected in the DOM, it is muted immediately then the skip-forward button is clicked after 300 ms
3. **CSS suppression** — all ad and upsell UI elements are hidden

---

## Requirements

- Samsung TV, 2019 or newer (Tizen 5.0+, Chromium M63+)
- [TizenBrew](https://github.com/reisxd/TizenBrew) already installed on the TV
- Spotify Free or Premium account
- iPhone (or any phone with a browser) on the same WiFi

---

## Install

**1. Push this repo to GitHub**

```
tizen-spotify/
├── package.json
├── userScript.js
└── service.js
```

**2. Install via TizenBrew Module Manager**

Open TizenBrew on the TV → Module Manager → add `yourusername/tizen-spotify`

**3. Set up the iPhone remote**

Open [https://unboundangel.github.io/Tizenfy/main.html](https://unboundangel.github.io/Tizenfy/main.html) in Safari on your iPhone. Enter the TV's IP address (Settings → Network → Network Status on the TV). Hit connect.

To add it to your home screen: Share → Add to Home Screen.

---

## Remote buttons

| Button | Action |
|---|---|
| Play / Pause | Toggle playback |
| Prev / Next | Skip tracks |
| Shuffle | Toggle shuffle |
| Repeat | Toggle repeat |
| Like | Save current track |
| Queue | Open queue |
| Home | Go to home feed |
| Search | Open search |
| Volume slider | Adjust volume |

The now-playing display updates every 5 seconds. An **AD** badge shows when an ad is being skipped.

The Samsung remote still works in parallel — you don't lose it.

---

## Samsung Remote Mapping

| Button | Action |
|---|---|
| Play / Pause / Stop | Playback control |
| Next / Fast Forward | Skip forward |
| Prev / Rewind | Skip back |
| Red | Shuffle |
| Green | Repeat |
| Yellow | Like |
| Blue | Queue |

---

## Debugging

Set `CONFIG.debug = true` in `userScript.js` to enable console logging. View logs via Tizen Studio's remote web inspector.

If ads start coming through after a Spotify DOM update, check `CONFIG.adSelectors` in `userScript.js` — Spotify occasionally changes their `data-testid` attribute names.

---

## Known limitations

- Spotify's web player isn't designed for TV navigation. Arrow key support is basic — it tabs through elements. A full spatial nav polyfill is a planned improvement.
- The login flow opens in the same webview and should work, but hasn't been tested across every account type.
- Older TVs (pre-2019) may not meet Spotify's minimum Chromium requirements.

---

## Project structure

```
tizen-spotify/
├── package.json      TizenBrew module config
├── userScript.js     Injected into open.spotify.com on the TV
├── service.js        WebSocket server (TizenBrew background service)
└── main.html         iPhone remote — hosted at unboundangel.github.io/Tizenfy/main.html
```

---

## Credits

Built on top of [TizenBrew](https://github.com/reisxd/TizenBrew) by reisxd. Ad blocking approach inspired by [adblockify](https://github.com/CharlieS1103/spicetify-marketplace) from the Spicetify marketplace.
