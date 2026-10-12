/* bridge.js — MAIN world. Passive observer of the page's own authenticated calls.
   Captures request headers (auth) and lat/lng, then postMessages the ISOLATED world.
   Never mutates requests. Classic script (no modules). */
(() => {
  'use strict';
  if (window.__ifoodComparaBridge) return;
  window.__ifoodComparaBridge = true;

  const SRC = 'ifood-compara-bridge';
  const RE_TARGET = /site-api|marketplace/i; // host/path must match to be relevant
  let lastHeadersKey = '';
  let lastCoordsKey = '';
  let lastHeaders = null;
  let lastCoords = null;

  function hostOf(url) {
    try { return new URL(String(url), location.href).host; } catch { return ''; }
  }

  function normalizeHeaders(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach((v, k) => { out[k] = v; });
      } else if (Array.isArray(h)) {
        for (const pair of h) { if (pair && pair.length >= 2) out[pair[0]] = pair[1]; }
      } else if (typeof h === 'object') {
        for (const k in h) out[k] = h[k];
      }
    } catch (_) { /* ignore malformed headers */ }
    return out;
  }

  function captureHeaders(url, raw) {
    const s = String(url || '');
    if (!RE_TARGET.test(s) && !RE_TARGET.test(hostOf(s))) return;
    const h = normalizeHeaders(raw);
    let hasAuth = false;
    const clean = {};
    for (const k in h) {
      const lk = k.toLowerCase();
      if (lk === 'authorization') hasAuth = true;
      if (lk === 'host' || lk === 'cookie' || lk === 'content-length') continue;
      clean[k] = h[k];
    }
    if (!hasAuth) return;
    const key = JSON.stringify(clean);
    lastHeaders = clean;
    if (key === lastHeadersKey) return;
    lastHeadersKey = key;
    window.postMessage({ source: SRC, type: 'headers', headers: clean }, '*');
  }

  function captureCoords(url) {
    let u;
    try { u = new URL(String(url), location.href); } catch { return; }
    const lat = u.searchParams.get('latitude') ?? u.searchParams.get('lat');
    const lng = u.searchParams.get('longitude') ?? u.searchParams.get('lng') ?? u.searchParams.get('lon');
    if (!lat || !lng) return;
    const key = lat + ',' + lng;
    lastCoords = { lat, lng };
    if (key === lastCoordsKey) return;
    lastCoordsKey = key;
    window.postMessage({ source: SRC, type: 'coords', lat, lng }, '*');
  }

  // Re-broadcast on demand (content script re-injected mid-session misses early posts).
  window.addEventListener('message', (evt) => {
    if (evt.source !== window) return;
    const d = evt.data;
    if (!d || d.source !== SRC || d.type !== 'need-capture') return;
    if (lastHeaders) window.postMessage({ source: SRC, type: 'headers', headers: lastHeaders }, '*');
    if (lastCoords) window.postMessage({ source: SRC, type: 'coords', lat: lastCoords.lat, lng: lastCoords.lng }, '*');
  });

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' || input instanceof URL
          ? String(input)
          : (input && input.url) || '';
        const headers = (init && init.headers) || (input && typeof input === 'object' && input.headers) || null;
        captureHeaders(url, headers);
        captureCoords(url);
      } catch (_) { /* never break the page */ }
      return origFetch.apply(this, arguments);
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSetHeader = XHR.prototype.setRequestHeader;
    const origSend = XHR.prototype.send;

    if (typeof origOpen === 'function') {
      XHR.prototype.open = function (method, url) {
        try { this.__ifoodUrl = url; this.__ifoodHeaders = {}; } catch (_) {}
        return origOpen.apply(this, arguments);
      };
    }
    if (typeof origSetHeader === 'function') {
      XHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (!this.__ifoodHeaders) this.__ifoodHeaders = {};
          this.__ifoodHeaders[name] = value;
        } catch (_) {}
        return origSetHeader.apply(this, arguments);
      };
    }
    if (typeof origSend === 'function') {
      XHR.prototype.send = function () {
        try {
          captureHeaders(this.__ifoodUrl, this.__ifoodHeaders);
          captureCoords(this.__ifoodUrl);
        } catch (_) { /* never break the page */ }
        return origSend.apply(this, arguments);
      };
    }
  }
})();
