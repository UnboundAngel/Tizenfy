/**
 * TizenSpotify - userScript.js
 * Ad-free Spotify for Samsung Tizen TVs
 * WebSocket client for iPhone remote control
 *
 * Strategy: Full page redirect to open.spotify.com
 * Ad handling: Mute (NOT block) - lets ad play silently, Spotify server stays happy
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

  function startAdWatcher() {
    let last = false;
    setInterval(() => {
      const now = isAdPlaying();
      if (now && !last) { muteAll(); last = true; }
      else if (!now && last) { unmuteAll(); last = false; }
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
