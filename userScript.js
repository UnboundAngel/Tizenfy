/**
 * TizenSpotify - userScript.js
 * Ad-free Spotify for Samsung Tizen TVs
 * WebSocket client for iPhone remote control
 *
 * Strategy: Full page redirect to open.spotify.com
 * Ad handling (3 layers, inspired by adblockify):
 *   1. Network interception — fetch/XHR override blocks known ad-delivery endpoints
 *   2. Auto-skip — detected ads are skipped immediately (muted first as safety net)
 *   3. CSS hide — ad UI elements are hidden regardless
 * Audio detection: Multi-layer fallback (createElement hook + DOM query + MutationObserver)
 * Remote: WebSocket to service.js, receives commands from iPhone web app
 */

(function () {
  'use strict';

  const CONFIG = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    wsPort: 8765,
    adSelectors: [
      '[data-testid="context-item-info-ad-subtitle"]',
      '.Root__ads-container',
      '[data-testid="advertisement"]',
      '[aria-label="Advertisement"]',
      '.now-playing > a[href*="ad"]',
    ],
    // Known Spotify ad-delivery URL patterns — requests matching these are blocked
    // returning an empty 200 so the player doesn't throw a network error.
    adUrlPatterns: [
      /\/ads\//i,
      /\/ad-logic\//i,
      /\/adeventtracker\//i,
      /spclient\.wg\.spotify\.com\/ad-logic/i,
      /audio-ak\.spotify\.com\/audio\/.*_ad/i,
      /pagead/i,
      /doubleclick\.net/i,
      /googlesyndication/i,
    ],
    // Milliseconds to wait after muting before attempting skip
    // (tiny delay avoids Spotify detecting an instant 0-second ad play)
    adSkipDelay: 300,
    // Minimum gap between auto-skips (prevents rapid-fire skipping on detection bounce)
    adSkipCooldown: 4000,
    adCSS: `
      .Root__ads-container,
      [data-testid="context-item-info-ad-subtitle"],
      [data-testid="advertisement"],
      [aria-label="Advertisement"],
      [aria-label="Upgrade to Premium"],
      .WiPggcPDzbwGxoxwLWFf,
      .premium-upsell-container {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        height: 0 !important;
        overflow: hidden !important;
      }
    `,
    audioPollInterval: 500,
    adCheckInterval: 300,
    wsReconnectDelay: 3000,
    statusInterval: 5000,
    debug: false,
  };

  const log = (...args) => { if (CONFIG.debug) console.log('[TizenSpotify]', ...args); };

  const state = {
    audioElements: new Set(),
    isMuted: false,
    ws: null,
    wsConnected: false,
    lastSkipAt: 0,
  };

  // ─── COMMAND MAP ─────────────────────────────────────────────────────────────

  const COMMANDS = {
    playpause:  () => clickSelector('[data-testid="control-button-playpause"]'),
    next:       () => clickSelector('[data-testid="control-button-skip-forward"]'),
    prev:       () => clickSelector('[data-testid="control-button-skip-back"]'),
    shuffle:    () => clickSelector('[data-testid="control-button-shuffle"]'),
    repeat:     () => clickSelector('[data-testid="control-button-repeat"]'),
    like:       () => clickSelector('[data-testid="add-button"]'),
    queue:      () => clickSelector('[data-testid="control-button-queue"]'),
    volumeup:   () => adjustVolume(+0.1),
    volumedown: () => adjustVolume(-0.1),
    search:     () => clickSelector('[data-testid="search-icon"]') || clickSelector('a[href="/search"]'),
    home:       () => clickSelector('a[href="/"]'),
  };

  function clickSelector(selector) {
    try {
      const el = document.querySelector(selector);
      if (el) { el.click(); log('Clicked:', selector); return true; }
      return false;
    } catch (e) { return false; }
  }

  function adjustVolume(delta) {
    state.audioElements.forEach(el => {
      el.volume = Math.min(1, Math.max(0, (el.volume || 1) + delta));
    });
  }

  function handleCommand(action) {
    log('Command:', action);
    if (COMMANDS[action]) { COMMANDS[action](); sendStatus(); }
  }

  // ─── WEBSOCKET ───────────────────────────────────────────────────────────────

  function connectWS() {
    try {
      const ws = new WebSocket(`ws://localhost:${CONFIG.wsPort}`);
      state.ws = ws;

      ws.onopen = () => {
        state.wsConnected = true;
        log('WS connected');
        ws.send(JSON.stringify({ type: 'register', role: 'script' }));
      };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (msg.type === 'command') handleCommand(msg.action);
      };

      ws.onclose = () => {
        state.wsConnected = false;
        setTimeout(connectWS, CONFIG.wsReconnectDelay);
      };

      ws.onerror = () => {};

    } catch (e) {
      setTimeout(connectWS, CONFIG.wsReconnectDelay);
    }
  }

  function sendStatus() {
    if (!state.ws || !state.wsConnected) return;
    try {
      const track = document.querySelector('[data-testid="context-item-info-title"]')?.textContent?.trim() || '';
      const artist = document.querySelector('[data-testid="context-item-info-subtitles"]')?.textContent?.trim() || '';
      const isPlaying = !!document.querySelector('[data-testid="control-button-playpause"][aria-label*="Pause"]');
      const isAd = isAdPlaying();
      state.ws.send(JSON.stringify({ type: 'status', track, artist, isPlaying, isAd }));
    } catch (e) {}
  }

  // ─── NETWORK INTERCEPTION (layer 1) ─────────────────────────────────────────

  function isAdUrl(url) {
    if (!url) return false;
    const str = typeof url === 'string' ? url : url.toString();
    return CONFIG.adUrlPatterns.some(re => re.test(str));
  }

  function interceptNetwork() {
    // Override fetch
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      if (isAdUrl(input instanceof Request ? input.url : input)) {
        log('Blocked ad fetch:', input);
        return Promise.resolve(new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
      }
      return origFetch.apply(this, arguments);
    };

    // Override XMLHttpRequest
    const OrigXHR = window.XMLHttpRequest;
    function PatchedXHR() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open.bind(xhr);
      let blocked = false;
      xhr.open = function (method, url, ...rest) {
        if (isAdUrl(url)) {
          log('Blocked ad XHR:', url);
          blocked = true;
          // Still call open so the object is valid, but we'll abort on send
          origOpen(method, url, ...rest);
          return;
        }
        origOpen(method, url, ...rest);
      };
      const origSend = xhr.send.bind(xhr);
      xhr.send = function (...args) {
        if (blocked) { xhr.abort(); return; }
        origSend(...args);
      };
      return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
  }

  // ─── USER AGENT ──────────────────────────────────────────────────────────────

  function setUserAgent() {
    try {
      if (typeof tizen !== 'undefined' && tizen.websetting) {
        tizen.websetting.setUserAgentString(CONFIG.userAgent, () => {}, () => {});
      }
    } catch (e) {}
    try {
      Object.defineProperty(navigator, 'userAgent', { get: () => CONFIG.userAgent, configurable: true });
    } catch (e) {}
  }

  // ─── CSS ─────────────────────────────────────────────────────────────────────

  function injectCSS() {
    const style = document.createElement('style');
    style.textContent = CONFIG.adCSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ─── AUDIO CAPTURE (3 layers) ────────────────────────────────────────────────

  function hookCreateElement() {
    const orig = document.createElement.bind(document);
    document.createElement = function (tag, ...args) {
      const el = orig(tag, ...args);
      if (typeof tag === 'string' && tag.toLowerCase() === 'audio') state.audioElements.add(el);
      return el;
    };
  }

  function startAudioPolling() {
    setInterval(() => {
      document.querySelectorAll('audio').forEach(el => {
        if (!state.audioElements.has(el)) {
          state.audioElements.add(el);
          if (state.isMuted) el.muted = true;
        }
      });
    }, CONFIG.audioPollInterval);
  }

  function watchForAudioElements() {
    new MutationObserver(mutations => {
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.nodeName === 'AUDIO') { state.audioElements.add(node); if (state.isMuted) node.muted = true; }
          if (node.querySelectorAll) {
            node.querySelectorAll('audio').forEach(el => {
              if (!state.audioElements.has(el)) { state.audioElements.add(el); if (state.isMuted) el.muted = true; }
            });
          }
        });
      });
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  // ─── AD DETECTION + MUTE ────────────────────────────────────────────────────

  function isAdPlaying() {
    for (const s of CONFIG.adSelectors) { try { if (document.querySelector(s)) return true; } catch (e) {} }
    return false;
  }

  function muteAll()   { if (!state.isMuted) { state.isMuted = true;  state.audioElements.forEach(el => el.muted = true);  } }
  function unmuteAll() { if (state.isMuted)  { state.isMuted = false; state.audioElements.forEach(el => el.muted = false); } }

  function trySkipAd() {
    const now = Date.now();
    if (now - state.lastSkipAt < CONFIG.adSkipCooldown) return;
    state.lastSkipAt = now;
    // Mute immediately so no ad audio leaks during the skip delay
    muteAll();
    setTimeout(() => {
      log('Auto-skipping ad');
      clickSelector('[data-testid="control-button-skip-forward"]');
    }, CONFIG.adSkipDelay);
  }

  function startAdWatcher() {
    let last = false;
    setInterval(() => {
      const now = isAdPlaying();
      if (now && !last) {
        last = true;
        trySkipAd();
      } else if (!now && last) {
        unmuteAll();
        last = false;
      }
    }, CONFIG.adCheckInterval);
  }

  // ─── SAMSUNG REMOTE (still works alongside iPhone) ──────────────────────────

  function setupSamsungRemote() {
    try {
      if (typeof tizen !== 'undefined' && tizen.tvinputdevice) {
        ['MediaPlayPause','MediaPlay','MediaPause','MediaStop','MediaFastForward',
         'MediaRewind','MediaTrackNext','MediaTrackPrevious',
         'ColorF0Red','ColorF1Green','ColorF2Yellow','ColorF3Blue',
        ].forEach(k => { try { tizen.tvinputdevice.registerKey(k); } catch(e){} });
      }
    } catch(e) {}

    const keyMap = {
      415: 'playpause', 19: 'playpause', 10252: 'playpause',
      417: 'next', 10233: 'next',
      412: 'prev', 10232: 'prev',
      403: 'shuffle', 404: 'repeat', 405: 'like', 406: 'queue',
    };

    window.addEventListener('keydown', e => {
      if (keyMap[e.keyCode]) handleCommand(keyMap[e.keyCode]);
    });
  }

  // ─── INIT ───────────────────────────────────────────────────────────────────

  function init() {
    interceptNetwork(); // Must run before any Spotify requests fire
    setUserAgent();
    hookCreateElement();

    const ready = () => {
      injectCSS();
      startAudioPolling();
      watchForAudioElements();
      startAdWatcher();
      setupSamsungRemote();
      connectWS();
      setInterval(sendStatus, CONFIG.statusInterval);
      log('TizenSpotify ready');
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
    else ready();
  }

  init();
})();
