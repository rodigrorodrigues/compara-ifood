/* content.js — ISOLATED world. Floating overlay, list parsing, price comparison,
   per-item product swap, and cart building via iFood's own APIs.
   Classic script (no modules). Talks to bridge.js only via window.postMessage. */
(() => {
  'use strict';
  if (window.__ifoodComparaContent) return;
  window.__ifoodComparaContent = true;

  // ---------- constants ----------
  const SRC = 'ifood-compara-bridge';
  const JEV_MODEL = 'typesafe/jev-1.13';
const JEV_ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
  const DEFAULT_JEV_KEY = '';
const CART_JOB_KEY = 'compara-cart-job';
const CART_DONE_KEY = 'compara-cart-done';
const ls = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
};
  const SEARCH_ALIAS = 'SEARCH_RESULTS_ITEM_TAB_GLOBAL';
  const SEARCH_ENDPOINT = 'https://www.ifood.com.br/site-api/v2/cardstack/search/results';
  // iFood rate-limits rapid sequential searches with 403s; wait between retries.
  const SEARCH_RETRY_WAITS = [4000, 8000, 15000];

  const PLACEHOLDER = 'Sua lista, um item por linha\nEx.:\n2x leite integral\n3 latas de cerveja';

  const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const money = (v) => (typeof v === 'number' && isFinite(v)) ? BRL.format(v) : '\u2014';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const UNIT = 'kg|gramas?|g|litros?|l|ml|latas?|pacotes?|unidades?|un|und|unid|caixas?|garrafas?|potes?|sacos?|d[u\u00fa]zias?|ma[c\u00e7]os?';
  const RE_X = /^(\d+)\s*[*xX\u00d7]\s*(.+)$/;
  const RE_UNIT = new RegExp('^(\\d+)\\s*(?:' + UNIT + ')\\.?\\s+(?:de\\s+)?(.+)$', 'i');
  const RE_BARE = /^(\d+)\s+(.+)$/;
  const RE_SUFFIX = /^(.+?)\s+(\d+)\s*[*xX\u00d7]$/;

  const SEARCH_BODY = JSON.stringify({
    'supported-headers': ['OPERATION_HEADER'],
    'supported-cards': ['MERCHANT_LIST', 'CATALOG_ITEM_LIST', 'CATALOG_ITEM_LIST_V2', 'CATALOG_ITEM_LIST_V3',
      'FEATURED_MERCHANT_LIST', 'CATALOG_ITEM_CAROUSEL', 'CATALOG_ITEM_CAROUSEL_V2', 'CATALOG_ITEM_CAROUSEL_V3',
      'BIG_BANNER_CAROUSEL', 'IMAGE_BANNER', 'MERCHANT_LIST_WITH_ITEMS_CAROUSEL', 'SMALL_BANNER_CAROUSEL',
      'NEXT_CONTENT', 'MERCHANT_CAROUSEL', 'MERCHANT_TILE_CAROUSEL', 'SIMPLE_MERCHANT_CAROUSEL', 'INFO_CARD',
      'MERCHANT_LIST_V2', 'ROUND_IMAGE_CAROUSEL', 'BANNER_GRID', 'MEDIUM_IMAGE_BANNER', 'MEDIUM_BANNER_CAROUSEL',
      'RELATED_SEARCH_CAROUSEL', 'FILTER_CAROUSEL', 'RANKING_CONTENT_LIST', 'ADS_BANNER'],
    'supported-actions': ['catalog-item', 'item-details', 'merchant', 'page', 'card-content', 'last-restaurants',
      'webmiddleware', 'reorder', 'search', 'groceries', 'groceries-details', 'home-tab'],
    'supported-filters': ['DEFAULT_SORTING', 'DISTANCE_FILTER', 'QUICK_FILTER_DELIVERY_FEE', 'QUICK_FILTER_IFOOD_DELIVERY',
      'QUICK_FILTER_SUPER_RESTAURANT', 'QUICK_FILTER_ONLINE_VR', 'QUICK_FILTER_MERCHANT_TYPE', 'QUICK_FILTER_STORE_TYPE',
      'QUICK_FILTER_TAKEOUT', 'QUICK_FILTER_TOTAL_PRICE', 'QUICK_FILTER_DELIVERY_TIME', 'KEYWORD_TOGGLE',
      'QUICK_FILTER_PROMOTION', 'SINGLE_SELECT_GRID', 'SINGLE_SELECT_RADIO', 'SINGLE_SELECT_WORDCLOUD',
      'MULTI_SELECT_CHECK', 'SLIDER', 'TOGGLE'],
    'feed-feature-name': '',
    'faster-overrides': ''
  });

  // ---------- state ----------
  let headers = null;
  let coords = coordsFromLocation();
  const state = { phase: 'idle', listText: '', markets: [], error: '', step: '', cart: null, openSwap: {}, openDetails: {} };

  // ---------- DOM helper ----------
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  // ---------- CSS (tokens reused from public/index.html) ----------
  const CSS = `
[hidden]{display:none !important;}
*{box-sizing:border-box;}
.overlay{
  --font:system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"Cascadia Mono",Consolas,"Courier New",monospace;
  --bg:#faf7f3;--surface:#fff;--text:#1c1917;--muted:#6f6a62;--border:#e6dfd5;
  --accent:#ea1d2c;--accent-strong:#c91525;--accent-ink:#c91525;--accent-weak:#fdecee;--on-accent:#fff;
  --green:#157f3d;--green-bg:#e4f3e9;--amber:#a15a00;--amber-bg:#fbefdc;--red:#b3261e;--red-bg:#fdebe9;
  --r1:6px;--r2:10px;--r3:999px;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;
  --t-xs:12px;--t-sm:13px;--t-md:15px;--t-lg:18px;--t-xl:24px;
  --shadow:0 1px 2px rgb(28 25 23/.05),0 10px 28px -18px rgb(28 25 23/.3);
  color-scheme:light dark;font-family:var(--font);font-size:var(--t-md);color:var(--text);
}
@media (prefers-color-scheme:dark){.overlay{
  --bg:#171615;--surface:#1f1e1c;--text:#f1eee9;--muted:#a49f97;--border:#34312d;
  --accent-strong:#ff3242;--accent-ink:#ff6b76;--accent-weak:#3a1c20;
  --green:#7ddb9a;--green-bg:#162e1e;--amber:#efb75f;--amber-bg:#31260f;--red:#ff7b73;--red-bg:#381a18;
  --shadow:0 1px 2px rgb(0 0 0/.35);
}}
button,textarea{font:inherit;color:inherit;}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
.fab{position:fixed;right:var(--s4);bottom:var(--s4);width:56px;height:56px;border-radius:50%;border:1px solid var(--accent);
  background:var(--accent);color:var(--on-accent);font-size:var(--t-xl);cursor:pointer;box-shadow:var(--shadow);
  display:grid;place-items:center;line-height:1;pointer-events:auto;}
.fab:hover{background:var(--accent-strong);}
.panel{position:fixed;right:var(--s4);bottom:calc(56px + var(--s4) + var(--s2));width:440px;
  max-width:calc(100vw - var(--s6));max-height:80vh;overflow:auto;pointer-events:auto;background:var(--bg);
  border:1px solid var(--border);border-radius:var(--r2);box-shadow:var(--shadow);}
.body{padding:var(--s4);}
.body>:first-child{margin-top:0;}
.view{margin-top:var(--s3);}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r2);padding:var(--s3);margin-top:var(--s3);}
.field-label{display:block;margin-bottom:var(--s2);color:var(--muted);font-size:var(--t-xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase;}
textarea{width:100%;min-height:110px;padding:var(--s2);border:1px solid var(--border);border-radius:var(--r1);
  background:var(--bg);resize:vertical;font-family:var(--mono);font-size:var(--t-sm);line-height:1.5;
  transition:border-color .15s,box-shadow .15s;}
textarea::placeholder{color:var(--muted);}
textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak);}
.form-row{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap;margin-top:var(--s2);}
.hint{color:var(--muted);font-size:var(--t-xs);}
.btn{display:inline-flex;align-items:center;gap:var(--s1);border:1px solid var(--border);background:var(--surface);
  padding:var(--s2) var(--s3);border-radius:var(--r1);font-size:var(--t-sm);font-weight:600;cursor:pointer;
  transition:background-color .15s,border-color .15s,color .15s;}
.btn:hover:not(:disabled){border-color:var(--muted);}
.btn:disabled{opacity:.55;cursor:not-allowed;}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);}
.btn.primary:hover:not(:disabled){background:var(--accent-strong);border-color:var(--accent-strong);}
.banner{display:flex;gap:var(--s2);align-items:flex-start;padding:var(--s2) var(--s3);border:1px solid var(--amber);
  border-radius:var(--r2);background:var(--amber-bg);color:var(--amber);margin-top:var(--s3);}
.banner .t{flex:1;}
.banner button{border:0;background:none;font-size:var(--t-lg);font-weight:700;cursor:pointer;line-height:1;color:inherit;padding:0 var(--s1);border-radius:var(--r1);}
.loading{display:flex;gap:var(--s3);align-items:flex-start;margin-top:var(--s3);}
.loading p{margin:0;}
.spinner{width:18px;height:18px;flex:none;border:2px solid var(--border);border-top-color:var(--accent);
  border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion:reduce){.spinner{animation:none;}.chev{transition:none;}.switch,.switch::after{transition:none;}}
.toolbar{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap;}
.stats{display:flex;align-items:center;gap:var(--s1);margin-left:auto;}
.stat{display:inline-flex;align-items:center;min-height:24px;padding:1px var(--s2);border:1px solid var(--border);
  border-radius:var(--r3);background:var(--surface);color:var(--muted);font-size:var(--t-xs);font-variant-numeric:tabular-nums;white-space:nowrap;}
.fbar{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap;margin-top:var(--s2);}
.tgroup{display:flex;align-items:center;gap:var(--s1);}
.tgroup.ia{margin-left:auto;padding-left:var(--s3);border-left:1px solid var(--border);}
.glabel{font-size:var(--t-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);}
.tgl{display:inline-flex;align-items:center;gap:var(--s1);min-height:26px;padding:2px var(--s3) 2px var(--s2);
  border:1px solid var(--border);border-radius:var(--r3);background:transparent;color:var(--muted);font-size:var(--t-xs);
  font-weight:600;cursor:pointer;transition:background-color .15s,border-color .15s,color .15s;}
.tgl:hover{border-color:var(--muted);color:var(--text);}
.tgl .tick{width:14px;height:14px;display:grid;place-items:center;border-radius:50%;border:1px solid var(--border);
  background:var(--bg);color:transparent;font-size:9px;line-height:1;transition:background-color .15s,border-color .15s,color .15s;}
.tgl[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-weak);color:var(--accent-ink);font-weight:700;}
.tgl[aria-pressed="true"] .tick{background:var(--accent);border-color:var(--accent);color:var(--on-accent);}
.market{background:var(--surface);border:1px solid var(--border);border-radius:var(--r2);box-shadow:var(--shadow);margin-top:var(--s2);}
.market.reco{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),var(--shadow);}
.mhead{display:flex;align-items:center;gap:var(--s2) var(--s3);padding:var(--s2) var(--s3);flex-wrap:wrap;}
.mhead .btn{white-space:nowrap;margin-left:auto;}
.rank{flex:none;width:24px;height:24px;display:grid;place-items:center;border-radius:50%;border:1px solid var(--border);
  background:var(--bg);color:var(--muted);font-size:var(--t-xs);font-weight:700;font-variant-numeric:tabular-nums;}
.market.reco .rank{background:var(--accent-weak);border-color:var(--accent);color:var(--accent-ink);}
.minfo{flex:1 1 160px;min-width:0;display:flex;flex-direction:column;gap:var(--s1);}
.mname{margin:0;display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap;min-width:0;font-size:var(--t-sm);font-weight:700;overflow-wrap:anywhere;}
.mtotal{margin-left:auto;text-align:right;font-size:var(--t-lg);font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;}
.badge{display:inline-block;padding:1px var(--s2);border-radius:var(--r3);font-size:var(--t-xs);font-weight:700;white-space:nowrap;}
.badge.reco{background:var(--accent-weak);color:var(--accent-ink);}
.badge.good{background:var(--green-bg);color:var(--green);}
.badge.mid{background:var(--amber-bg);color:var(--amber);}
.badge.low{background:var(--red-bg);color:var(--red);}
details{border-top:1px solid var(--border);}
summary{display:flex;align-items:center;gap:var(--s1);padding:var(--s2) var(--s3);cursor:pointer;color:var(--muted);
  font-size:var(--t-xs);font-weight:700;list-style:none;}
summary::-webkit-details-marker{display:none;}
summary:hover{color:var(--text);}
.chev{display:inline-block;margin-left:auto;transition:transform .15s;font-size:var(--t-md);line-height:1;}
details[open] .chev{transform:rotate(90deg);}
.items{margin:0;padding:0 var(--s3) var(--s3);list-style:none;}
.items li{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto auto;gap:2px var(--s2);align-items:center;padding:2px 0;font-size:var(--t-xs);}
.items .who{display:flex;flex-direction:column;gap:1px;min-width:0;}
.items .ihead{border-bottom:1px solid var(--border);padding-bottom:var(--s1);color:var(--muted);font-weight:700;letter-spacing:.05em;text-transform:uppercase;}
.items .q{font-weight:600;overflow-wrap:anywhere;}
.items .p{color:var(--muted);overflow-wrap:anywhere;}
.items .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.items .qty{width:62px;display:inline-flex;align-items:center;justify-content:flex-end;gap:var(--s1);}
.items .unit{width:58px;color:var(--muted);}
.items .tot{width:62px;font-weight:700;}
.items .missing .q,.items .missing .p{color:var(--red);text-decoration:line-through;font-style:italic;}
.swap{border:1px solid var(--border);background:var(--surface);border-radius:var(--r3);padding:2px var(--s1);
  font-size:var(--t-xs);font-weight:600;cursor:pointer;white-space:nowrap;transition:border-color .15s,color .15s,background-color .15s;}
.swap.ghost{visibility:hidden;pointer-events:none;}
.swap:hover{border-color:var(--accent);color:var(--accent-ink);}
.swap.on{border-color:var(--accent);background:var(--accent-weak);color:var(--accent-ink);}
.items .altsrow{display:block;padding:0;}
.alts{display:flex;flex-direction:column;gap:2px;padding:0 0 var(--s2);}
.altrow{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:var(--s2);align-items:baseline;width:100%;
  border:1px solid transparent;background:transparent;border-radius:var(--r1);padding:var(--s1) var(--s2);font-size:var(--t-xs);text-align:left;cursor:pointer;color:inherit;}
.altrow:hover{background:var(--bg);}
.altrow.on{background:var(--accent-weak);border-color:var(--accent);}
.altrow .tick{color:var(--accent-ink);font-weight:700;text-align:center;}
.altrow .aname{display:flex;align-items:baseline;gap:var(--s1);min-width:0;overflow-wrap:anywhere;}
.altrow .dots{flex:1 1 var(--s3);min-width:var(--s2);border-bottom:1px dotted var(--border);}
.altrow .aprice{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap;}
.altrow.on .aprice{color:var(--accent-ink);font-weight:700;}
.altrow.reset{border-top:1px dashed var(--border);border-radius:0;color:var(--muted);}
.altrow.reset:hover{color:var(--text);background:transparent;}
.step{display:block;margin-top:var(--s2);}
.ok{color:var(--green);}
.bad{color:var(--red);}
.muted{color:var(--muted);}
.checklist{margin:var(--s3) 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:var(--s1);font-size:var(--t-sm);}
.checklist li{display:flex;gap:var(--s1);align-items:baseline;overflow-wrap:anywhere;}
.cart-step{margin:0;font-weight:600;}
.qtybtn{border:1px solid var(--border);background:var(--surface);border-radius:var(--r1);width:20px;height:20px;display:grid;place-items:center;line-height:1;cursor:pointer;font-weight:700;padding:0;color:inherit;}
.qtybtn:hover{border-color:var(--accent);color:var(--accent-ink);}
.qtyp{min-width:14px;text-align:center;font-variant-numeric:tabular-nums;}
.jev{margin-top:var(--s3);border-top:1px solid var(--border);padding-top:var(--s3);}
.jrow{display:flex;align-items:center;gap:var(--s3);}
.jtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.jtitle{font-size:var(--t-sm);font-weight:700;}
.jtitle em{font-style:normal;color:var(--accent);}
.jkey{display:flex;flex-direction:column;gap:var(--s1);margin-top:var(--s2);}
.jkey input{width:100%;padding:var(--s1) var(--s2);border:1px solid var(--border);border-radius:var(--r1);background:var(--bg);color:var(--text);font-size:var(--t-xs);}
.switch{position:relative;flex:none;width:38px;height:22px;margin:0;padding:0;border:1px solid var(--border);border-radius:var(--r3);background:var(--bg);cursor:pointer;transition:background-color .15s,border-color .15s;}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--muted);transition:transform .18s,background-color .15s;}
.switch.on{background:var(--accent-weak);border-color:var(--accent);}
.switch.on::after{transform:translateX(16px);background:var(--accent);}`;

  // ---------- overlay ----------
  const host = document.createElement('div');
  host.id = 'ifood-compara-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  const overlay = h('div', { class: 'overlay' });
  const fab = h('button', { class: 'fab', type: 'button', title: 'Compara iFood',
    'aria-label': 'Abrir o Compara iFood', onclick: () => { panel.hidden = !panel.hidden; if (!panel.hidden) render(); } }, '\uD83D\uDED2');
  const panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Compara iFood' });
  panel.hidden = true;
  shadow.append(styleEl, overlay);
  overlay.append(fab, panel);
  (document.body || document.documentElement).append(host);

  // Resume a pending cart job across navigations (each ?item= page load re-injects us).
  (function resumeCart() {
    try {
      const done = sessionStorage.getItem(CART_DONE_KEY);
      if (done) {
        sessionStorage.removeItem(CART_DONE_KEY);
        const d = JSON.parse(done);
        if (d.list) state.listText = d.list;
        state.phase = 'cart';
        state.cart = { phase: 'done', marketName: d.marketName, added: d.added || [], failed: d.failed || [], error: '' };
        panel.hidden = false;
        render();
        return;
      }
      const job = loadJob();
      if (job) {
        if (job.list) state.listText = job.list;
        state.phase = 'cart';
        state.cart = { phase: 'loading', marketName: '', count: 0 };
        panel.hidden = false;
        render();
        runCartJob();
        return;
      }
      const pending = ls.get('compara.pending', '');
      if (pending) {
        state.listText = pending;
        panel.hidden = false;
        render();
        setTimeout(() => { void runSearch(); }, 1500);
      }
    } catch { /* ignore */ }
  })();

  // ---------- bridge messages ----------
  window.addEventListener('message', (evt) => {
    if (evt.source !== window) return;
    const d = evt.data;
    if (!d || d.source !== SRC) return;
    if (d.type === 'headers' && d.headers) headers = d.headers;
    else if (d.type === 'coords' && d.lat && d.lng) coords = { lat: d.lat, lng: d.lng };
    else return;
    if (!panel.hidden && (state.phase === 'idle' || state.phase === 'error')) render();
  });

  // ---------- list parsing ----------
  function parseList(text) {
    const items = [];
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let qty = 1, query = line;
      let m = line.match(RE_X);
      if (!m) m = line.match(RE_UNIT);
      if (!m) m = line.match(RE_SUFFIX);
      if (!m) m = line.match(RE_BARE);
      if (m) { qty = parseInt(m[1], 10) || 1; query = (m[2] || '').trim(); }
      if (query) items.push({ qty, query });
    }
    return items;
  }

  // ---------- price helpers ----------
  const centsToReais = (cents) => (typeof cents === 'number' && isFinite(cents) ? cents / 100 : NaN);
  function slugFromAction(action) {
    if (typeof action !== 'string') return '';
    const m = action.match(/[?&]slug=([^&]+)/);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  function storeUrl(slug, id) {
    return slug ? 'https://www.ifood.com.br/delivery/' + slug + '/' + id
      : 'https://www.ifood.com.br/delivery/' + id;
  }

  // ---------- response parsing (generic walk) ----------
  // Merchant tab entries carry mainCategory ("Mercado", "Restaurante", ...); remember
  // it so aggregate can drop restaurants that matched food words from menus.
  const merchantCategory = new Map();
  function extractHits(root) {
    const hits = [];
    const seen = new Set();
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (typeof node.id === 'string' && typeof node.mainCategory === 'string') {
        merchantCategory.set(node.id, node.mainCategory);
      }
      if (typeof node.id === 'string' && typeof node.name === 'string' && Array.isArray(node.items)) {
        const slug = slugFromAction(node.action);
        for (const it of node.items) {
          if (!it || typeof it.id !== 'string' || typeof it.name !== 'string') continue;
          const cents = it.pricing && it.pricing.unitPrice;
          if (typeof cents !== 'number') continue;
          const key = node.id + '|' + it.name;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ merchantId: node.id, merchantName: node.name, slug,
            itemId: it.id, itemName: it.name, price: centsToReais(cents) });
        }
      }
      for (const k in node) walk(node[k]);
    })(root);
    return hits;
  }

  // ---------- Jev (OpenRouter System One) ----------
  async function applyJev(perQuery) {
    const key = ls.get('compara.jevKey', DEFAULT_JEV_KEY);
    if (!key) throw new Error('sem API key');
    for (const q of perQuery) {
      // Rank candidates by query-token overlap (name starting with the query first),
      // so junk that merely mentions the term doesn't crowd out real matches.
      const qTokens = q.query.toLowerCase().split(/\s+/).filter(Boolean);
      const score = (name) => {
        const n = name.toLowerCase();
        let ov = qTokens.filter((t) => n.includes(t)).length;
        if (qTokens[0] && n.startsWith(qTokens[0])) ov += 1.5;
        return ov;
      };
      const ranked = q.hits.slice().sort((a, b) => score(b.itemName) - score(a.itemName) || a.price - b.price);
      const names = [];
      const priceOf = {};
      const seen = new Set();
      for (const hit of ranked) {
        if (seen.has(hit.itemName)) continue;
        seen.add(hit.itemName);
        names.push(hit.itemName);
        priceOf[hit.itemName] = hit.price;
        if (names.length >= 15) break;
      }
      if (names.length < 2) continue;
      const criteria = {};
      names.forEach((n, i) => { criteria['P' + i] = n; });
      const res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: 'Lista de compras do usuario: "' + q.query + '". Candidatos: '
            + names.map((n, i) => 'P' + i + ') ' + n + ' (R$ ' + priceOf[n].toFixed(2) + ') ').join(', '),
          questions: {
            q: {
              type: 'choice',
              instructions: 'Qual produto atende melhor ao pedido "' + q.query
                + '"? O produto deve SER o pedido, nao apenas conter o termo (ex: "doce de leite" nao e leite).'
                + ' Priorize o tipo exato; marca e tamanho podem variar.',
              criteria
            }
          }
        })
      });
      if (!res.ok) throw new Error('Jev HTTP ' + res.status);
      const data = await res.json();
      const choice = data && data.answers && data.answers.q && data.answers.q.choice;
      if (choice && criteria[choice]) q.jevName = criteria[choice];
    }
  }

  function changeQty(query, delta) {
    for (const m of state.markets) {
      for (const it of m.items) {
        if (it.query !== query) continue;
        it.qty = Math.min(99, Math.max(1, it.qty + delta));
      }
      m.total = marketTotal(m.items);
    }
    sortMarkets(state.markets);
    render();
  }

  // ---------- aggregation ----------
  const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'com', 'sem', 'para', 'por', 'un', 'und', 'g', 'kg', 'ml', 'l', 'x']);
  function norm(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  function tokens(s) { return norm(s).split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t)); }
  function hasAllQueryTokens(name, qTokens) {
    const n = norm(name);
    return qTokens.every((t) => n.includes(t));
  }
  function overlapRatio(aTokens, bTokens) {
    if (!aTokens.length || !bTokens.length) return 0;
    const bs = new Set(bTokens);
    let common = 0;
    for (const t of aTokens) if (bs.has(t)) common++;
    return common / Math.min(aTokens.length, bTokens.length);
  }
  function marketTotal(items) {
    let t = 0;
    for (const it of items) if (it.matched) t += it.pool[it.chosenIndex].price * it.qty;
    return t;
  }
  function isRestaurant(merchantId) {
    return /restaurante/i.test(merchantCategory.get(merchantId) || '');
  }
  // Coverage first, then price: incomplete markets must never outrank complete ones
  // just because missing items make their total look cheaper.
  function sortMarkets(list) {
    list.sort((a, b) => (b.found - a.found) || (a.total - b.total));
    return list;
  }
  function aggregate(perQuery) {
    const byMerchant = new Map();
    for (const q of perQuery) {
      for (const hit of q.hits) {
        if (isRestaurant(hit.merchantId)) continue;
        let m = byMerchant.get(hit.merchantId);
        if (!m) { m = { id: hit.merchantId, name: hit.merchantName, slug: hit.slug, pools: new Map() }; byMerchant.set(hit.merchantId, m); }
        let arr = m.pools.get(q.query);
        if (!arr) { arr = []; m.pools.set(q.query, arr); }
        arr.push(hit);
      }
    }
    const markets = [];
    for (const m of byMerchant.values()) {
      const items = perQuery.map((q) => {
        const qTokens = tokens(q.query);
        // iFood returns fuzzy hits ("leite condensado" -> "Pudim de Leite Condensado"):
        // only products containing EVERY query token are eligible for this request.
        const pool = (m.pools.get(q.query) || [])
          .filter((h) => hasAllQueryTokens(h.itemName, qTokens))
          .slice()
          .sort((a, b) => a.price - b.price);
        if (!pool.length) return { query: q.query, qty: q.qty, matched: false, pool: [] };
        let chosenIndex = 0;
        if (q.jevName) {
          const idx = pool.findIndex((hit) => hit.itemName === q.jevName);
          if (idx >= 0) {
            chosenIndex = idx;
          } else {
            // Jev's pick isn't sold here: accept only a close substitute, else mark missing.
            const target = tokens(q.jevName);
            let best = -1;
            let bestScore = 0;
            pool.forEach((hit, i) => {
              const score = overlapRatio(tokens(hit.itemName), target);
              if (score > bestScore) { bestScore = score; best = i; }
            });
            if (best < 0 || bestScore < 0.6) return { query: q.query, qty: q.qty, matched: false, pool };
            chosenIndex = best;
          }
        }
        return { query: q.query, qty: q.qty, matched: true, pool, chosenIndex };
      });
      const found = items.filter((i) => i.matched).length;
      if (found === 0) continue;
      markets.push({ id: m.id, name: m.name, url: storeUrl(m.slug, m.id), items, found, count: items.length, total: marketTotal(items) });
    }
    return sortMarkets(markets);
  }

  // ---------- search ----------
  function jsonHeaders() {
    const out = {};
    for (const k in headers) { if (k.toLowerCase() === 'content-type') continue; out[k] = headers[k]; }
    out['content-type'] = 'application/json';
    return out;
  }
  function coordsFromLocation() {
    try {
      const p = new URLSearchParams(location.search);
      const lat = p.get('latitude'), lng = p.get('longitude');
      if (lat && lng) return { lat, lng };
    } catch { /* ignore */ }
    return null;
  }
  // iFood persists the delivery point in localStorage fstr.session.
  function coordsFromStorage() {
    try {
      const s = JSON.parse(localStorage.getItem('fstr.session') || 'null');
      const lat = (s && s.properties && s.properties.delLat) || (s && s.geoPoint && s.geoPoint.latitude);
      const lng = (s && s.properties && s.properties.delLon) || (s && s.geoPoint && s.geoPoint.longitude);
      if (lat && lng) return { lat: String(lat), lng: String(lng) };
    } catch { /* ignore */ }
    return null;
  }
  function searchUrl(q) {
    return SEARCH_ENDPOINT + '?alias=' + SEARCH_ALIAS + '&term=' + encodeURIComponent(q)
      + '&latitude=' + encodeURIComponent(coords.lat) + '&longitude=' + encodeURIComponent(coords.lng)
      + '&channel=IFOOD&size=20';
  }
  async function searchTerm(query) {
    // iFood answers rapid sequential POSTs with 403 (short-window rate limit, not auth);
    // each retry waits longer before trying again.
    for (let attempt = 0; attempt <= SEARCH_RETRY_WAITS.length; attempt++) {
      try {
        const res = await fetch(searchUrl(query), {
          method: 'POST',
          headers: jsonHeaders(),
          credentials: 'include',
          body: SEARCH_BODY
        });
        if (!res.ok) throw new Error('busca HTTP ' + res.status);
        const hits = extractHits(await res.json());
        if (hits.length) return hits;
      } catch (_) { /* retry below */ }
      if (attempt < SEARCH_RETRY_WAITS.length) {
        const ms = SEARCH_RETRY_WAITS[attempt];
        state.step = 'O iFood est\u00e1 limitando as buscas. Nova tentativa em ' + Math.round(ms / 1000) + 's.';
        render();
        await sleep(ms);
      }
    }
    return [];
  }
  async function ensureSession() {
    // Ask the bridge to re-broadcast cached headers (covers mid-session reinjection).
    try { window.postMessage({ source: 'ifood-compara-bridge', type: 'need-capture' }, '*'); } catch { /* ignore */ }
    if (!headers) {
      const t0 = Date.now();
      while (!headers && Date.now() - t0 < 5000) {
        state.step = 'Conectando com o iFood\u2026';
        render();
        try { window.postMessage({ source: 'ifood-compara-bridge', type: 'need-capture' }, '*'); } catch { /* ignore */ }
        await sleep(250);
      }
      // Idle page never fired an auth XHR -> reload once; init resumes the compare.
      if (!headers) {
        let reloads = 0;
        try { reloads = Number(sessionStorage.getItem('compara.reloads') || '0'); } catch { /* ignore */ }
        if (reloads < 1) {
          try { sessionStorage.setItem('compara.reloads', '1'); } catch { /* ignore */ }
          ls.set('compara.pending', state.listText);
          location.reload();
          return;
        }
      }
    }
    if (!headers) throw new Error('N\u00e3o deu pra falar com o iFood. Recarrega a p\u00e1gina e tenta de novo.');
    try { sessionStorage.removeItem('compara.reloads'); } catch { /* ignore */ }
    if (!coords) coords = coordsFromLocation();
    if (!coords) coords = coordsFromStorage();
    if (!coords) throw new Error('N\u00e3o achei sua localiza\u00e7\u00e3o. Faz uma busca no iFood e tenta de novo.');
  }
  async function runSearch() {
    const pending = ls.get('compara.pending', '');
    ls.set('compara.pending', '');
    const items = parseList(pending || state.listText);
    if (!items.length) { state.error = 'Escreve pelo menos um item.'; state.phase = 'error'; render(); return; }
    state.phase = 'loading'; state.step = 'Conferindo sua sess\u00e3o\u2026'; state.error = ''; render();
    try {
      await ensureSession();
      const perQuery = [];
      for (let i = 0; i < items.length; i++) {
        state.step = 'Buscando \u201c' + items[i].query + '\u201d (' + (i + 1) + ' de ' + items.length + ')\u2026';
        render();
        perQuery.push({ query: items[i].query, qty: items[i].qty, hits: await searchTerm(items[i].query) });
        if (i < items.length - 1) await sleep(2000 + Math.random() * 1500);
      }
      if (ls.get('compara.jevOn', '') === '1') {
        state.step = 'A Jev est\u00e1 escolhendo os produtos\u2026';
        render();
        try {
          await applyJev(perQuery);
        } catch (e) {
          state.error = 'A Jev n\u00e3o respondeu (' + ((e && e.message) || 'erro') + '). Seguimos com o mais barato de cada item.';
        }
      }
      state.markets = aggregate(perQuery);
      const blocked = perQuery.filter((q) => !q.hits.length).length;
      if (!state.markets.length) {
        state.error = 'Nada encontrado. Tenta termos mais simples, tipo \u201cleite\u201d.';
        state.phase = 'error'; render(); return;
      }
      if (blocked) {
        const blockedLabel = blocked === 1 ? '1 busca ficou' : blocked + ' buscas ficaram';
        state.error = blockedLabel + ' sem resposta agora. O resto da lista j\u00e1 comparou. '
          + 'D\u00e1 uma pausa de uns minutos e tenta de novo.';
      }
      state.phase = 'results'; state.step = ''; render();
    } catch (e) {
      state.error = (e && e.message) || 'Falha ao buscar pre\u00e7os.';
      state.phase = 'error'; render();
    }
  }

  // ---------- cart: UI flow (product page ?item= + real "Adicionar" click) ----------
  function saveJob(job) { sessionStorage.setItem(CART_JOB_KEY, JSON.stringify(job)); }
  function loadJob() {
    try { return JSON.parse(sessionStorage.getItem(CART_JOB_KEY)); } catch { return null; }
  }
  // Searches the page DOM (not the shadow overlay) for a visible button.
  function findButton(re) {
    for (const b of document.querySelectorAll('button')) {
      if (b.offsetParent === null) continue;
      const t = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
      if (re.test(t)) return b;
    }
    return null;
  }

  async function runCartJob() {
    const job = loadJob();
    if (!job) return;
    if (job.idx >= job.items.length) {
      sessionStorage.removeItem(CART_JOB_KEY);
      sessionStorage.setItem(CART_DONE_KEY,
        JSON.stringify({ marketName: job.marketName, added: job.added, failed: job.failed, list: job.list || state.listText }));
      state.phase = 'cart';
      state.cart = { phase: 'loading', marketName: job.marketName, count: job.added.length,
        detail: 'Quase l\u00e1. Voltando pra loja\u2026' };
      render();
      location.assign(job.url);
      return;
    }
    const item = job.items[job.idx];
    if (!location.href.includes('item=' + item.itemId)) {
      state.phase = 'cart';
      state.cart = { phase: 'loading', marketName: job.marketName, count: job.items.length,
        detail: 'Adicionando ' + (job.idx + 1) + '/' + job.items.length + ': ' + item.name };
      render();
      location.assign(job.url + '?item=' + item.itemId);
      return;
    }
    const deadline = Date.now() + 25_000;
    let btn = null;
    while (Date.now() < deadline && !btn) {
      btn = findButton(/adicionar/i);
      if (!btn) await sleep(400);
    }
    if (!btn) {
      job.failed.push(item.name);
    } else {
      for (let u = 0; u < item.qty; u++) {
        const b = u === 0 ? btn
          : findButton(/^\+$|aumentar|adicionar mais/i) || findButton(/adicionar/i);
        if (!b) break;
        b.click();
        await sleep(1600);
      }
      job.added.push(item.name + (item.qty > 1 ? ' x' + item.qty : ''));
    }
    job.idx += 1;
    saveJob(job);
    runCartJob();
  }

  function mountCart(market) {
    const items = market.items.filter((i) => i.matched).map((i) => ({
      itemId: i.pool[i.chosenIndex].itemId,
      name: i.pool[i.chosenIndex].itemName,
      qty: i.qty,
      query: i.query
    }));
    if (!items.length) {
      state.error = 'Este mercado n\u00e3o tem nenhum item da lista.';
      render();
      return;
    }
    saveJob({ url: market.url, marketName: market.name, list: state.listText, items, idx: 0, added: [], failed: [] });
    runCartJob();
  }

  // ---------- rendering ----------
  function errorBanner() {
    return h('div', { class: 'banner', role: 'alert' },
      h('span', { class: 't' }, state.error),
      h('button', { type: 'button', 'aria-label': 'Fechar aviso', onclick: () => { state.error = ''; render(); } }, '\u00d7'));
  }

  function jevSettings() {
    const on = ls.get('compara.jevOn', '') === '1';
    const keyInput = h('input', { type: 'password', id: 'jev-key', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Chave da OpenRouter' });
    keyInput.value = ls.get('compara.jevKey', DEFAULT_JEV_KEY);
    keyInput.addEventListener('input', () => ls.set('compara.jevKey', keyInput.value.trim()));
    const keyRow = h('label', { class: 'jkey' }, h('span', { class: 'hint' }, 'Chave da OpenRouter'), keyInput);
    keyRow.hidden = !on;
    const sw = h('button', { class: 'switch' + (on ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': 'Escolha autom\u00e1tica com a Jev' });
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next); sw.setAttribute('aria-checked', String(next));
      ls.set('compara.jevOn', next ? '1' : ''); keyRow.hidden = !next;
    });
    return h('div', { class: 'jev' },
      h('div', { class: 'jrow' },
        h('div', { class: 'jtext' },
          h('span', { class: 'jtitle' }, 'Escolha autom\u00e1tica ', h('em', {}, 'Jev')),
          h('span', { class: 'hint' }, 'A Jev escolhe o produto mais fiel a cada item da lista.')),
        sw),
      keyRow);
  }
  function idleView() {
    const ta = h('textarea', { placeholder: PLACEHOLDER, spellcheck: 'false', 'aria-label': 'Sua lista de compras' });
    ta.value = state.listText;
    ta.addEventListener('input', () => { state.listText = ta.value; });
    ta.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runSearch(); } });
    const btn = h('button', { class: 'btn primary', type: 'button', onclick: runSearch }, 'Comparar pre\u00e7os');
    return h('div', { class: 'card' },
      h('label', { class: 'field-label' }, 'Sua lista de compras'),
      ta,
      h('div', { class: 'form-row' }, btn, h('span', { class: 'hint' }, 'Um item por linha \u00b7 Ctrl+Enter busca na hora')),
      jevSettings());
  }
  function loadingView() {
    const box = h('div', { class: 'card' },
      h('div', { class: 'loading' },
        h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        h('p', {}, 'Buscando pre\u00e7os\u2026')));
    if (state.step) box.append(h('p', { class: 'hint step', 'aria-live': 'polite' }, state.step));
    return box;
  }
  function coverageBadge(found, count) {
    const ratio = count ? found / count : 0;
    const cls = ratio >= 0.9 ? 'good' : ratio >= 0.6 ? 'mid' : 'low';
    return h('span', { class: 'badge ' + cls }, found + '/' + count + ' itens');
  }
  function chooseAlt(market, item, key, idx) {
    item.chosenIndex = idx;
    market.total = marketTotal(market.items);
    sortMarkets(state.markets);
    render();
  }
  function altPicker(market, item, key) {
    const order = [item.chosenIndex];
    for (let i = 0; i < item.pool.length && order.length < 12; i++) if (i !== item.chosenIndex) order.push(i);
    let cheapest = 0;
    item.pool.forEach((hit, i) => { if (hit.price < item.pool[cheapest].price) cheapest = i; });
    const box = h('div', { class: 'alts', role: 'group', 'aria-label': 'Outras op\u00e7\u00f5es para ' + item.query });
    for (const idx of order) {
      const hit = item.pool[idx];
      const on = idx === item.chosenIndex;
      box.append(h('button', {
        class: 'altrow' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => chooseAlt(market, item, key, idx)
      },
        h('span', { class: 'tick' }, on ? '\u2713' : ''),
        h('span', { class: 'aname' }, hit.itemName, h('span', { class: 'dots', 'aria-hidden': 'true' })),
        h('span', { class: 'aprice' }, money(hit.price))));
    }
    box.append(h('button', { class: 'altrow reset', type: 'button', onclick: () => chooseAlt(market, item, key, cheapest) },
      h('span', { class: 'tick' }, '\u21ba'),
      h('span', { class: 'aname' }, 'Usar o mais barato', h('span', { class: 'dots', 'aria-hidden': 'true' })),
      h('span', { class: 'aprice' }, money(item.pool[cheapest].price))));
    return box;
  }
  // Ghost keeps the last grid track identical on header/missing rows (same content, hidden).
  function swapGhost() {
    return h('button', { class: 'swap ghost', type: 'button', 'aria-hidden': 'true', tabindex: '-1' }, '\u21bb Trocar');
  }
  function itemRows(market, keyFor) {
    const frag = document.createDocumentFragment();
    const head = h('li', { class: 'ihead' });
    [['Item', ''], ['Qtd', 'num qty'], ['Pre\u00e7o', 'num unit'], ['Total', 'num tot']].forEach((c) => head.append(h('span', { class: c[1] || null }, c[0])));
    head.append(swapGhost());
    frag.append(head);
    for (const item of market.items) {
      if (!item.matched) {
        frag.append(h('li', { class: 'missing' },
          h('span', { class: 'who' }, h('span', { class: 'q' }, item.query), h('span', { class: 'p' }, 'n\u00e3o encontrado')),
          h('span', { class: 'num qty' }, item.qty + 'x'),
          h('span', { class: 'num unit' }, '\u2014'),
          h('span', { class: 'num tot' }, '\u2014'),
          swapGhost()));
        continue;
      }
      const chosen = item.pool[item.chosenIndex];
      const key = keyFor(item);
      const open = !!state.openSwap[key];
      const qtyBox = h('span', { class: 'num qty' },
        h('button', { class: 'qtybtn', type: 'button', 'aria-label': 'Diminuir a quantidade de ' + item.query, onclick: () => changeQty(item.query, -1) }, '\u2212'),
        h('span', { class: 'qtyp' }, String(item.qty)),
        h('button', { class: 'qtybtn', type: 'button', 'aria-label': 'Aumentar a quantidade de ' + item.query, onclick: () => changeQty(item.query, 1) }, '+'));
      frag.append(h('li', {},
        h('span', { class: 'who' }, h('span', { class: 'q' }, item.query), h('span', { class: 'p' }, chosen.itemName)),
        qtyBox,
        h('span', { class: 'num unit' }, money(chosen.price)),
        h('span', { class: 'num tot' }, money(chosen.price * item.qty)),
        h('button', { class: 'swap' + (open ? ' on' : ''), type: 'button',
          'aria-label': 'Trocar o produto de ' + item.query, 'aria-expanded': open ? 'true' : 'false',
          onclick: () => { state.openSwap[key] = !open; render(); } }, '\u21bb Trocar')));
      if (open) frag.append(h('li', { class: 'altsrow' }, altPicker(market, item, key)));
    }
    return frag;
  }
  function marketCard(market, rank) {
    const card = h('article', { class: 'market' + (rank === 1 ? ' reco' : '') });
    const name = h('h3', { class: 'mname' }, market.name);
    if (rank === 1) name.append(h('span', { class: 'badge reco' }, '\u2b50 Mais barato'));
    const cartBtn = h('button', { class: 'btn' + (rank === 1 ? ' primary' : ''), type: 'button', disabled: market.found === 0,
      onclick: () => mountCart(market) }, '\uD83D\uDED2 Montar carrinho');
    const head = h('div', { class: 'mhead' },
      h('span', { class: 'rank' }, String(rank)),
      h('div', { class: 'minfo' }, name, coverageBadge(market.found, market.count)),
      h('div', { class: 'mtotal' }, money(market.total)),
      cartBtn);
    const ul = h('ul', { class: 'items' });
    ul.append(itemRows(market, (item) => market.id + '|' + item.query));
    const details = h('details', {},
      h('summary', {}, 'Ver itens (' + market.count + ')', h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
      ul);
    // render() rebuilds the card, so expansion must come from state or every
    // click inside the list (trocar/qty/filtro) would collapse it.
    if (state.openDetails[market.id]) details.open = true;
    details.addEventListener('toggle', () => { state.openDetails[market.id] = details.open; });
    card.append(head, details);
    return card;
  }
  function tgl(label, on, onClick, title) {
    return h('button', { class: 'tgl', type: 'button', 'aria-pressed': on ? 'true' : 'false', title: title || null, onclick: onClick },
      h('span', { class: 'tick', 'aria-hidden': 'true' }, '\u2713'), label);
  }
  function lsToggle(label, key, title) {
    const on = ls.get(key, '') === '1';
    return tgl(label, on, () => { ls.set(key, on ? '' : '1'); render(); }, title);
  }
  function resultsView() {
    const box = h('div', { class: 'view' });
    const onlyComplete = ls.get('compara.onlyComplete', '') === '1';
    const visible = onlyComplete ? state.markets.filter((m) => m.found === m.count) : state.markets;
    const total = state.markets.length;
    const itemCount = total ? state.markets[0].count : 0;
    const n = onlyComplete && visible.length !== total ? visible.length + ' de ' + total : total;
    const countLabel = n + (total === 1 ? ' mercado' : ' mercados');
    box.append(h('div', { class: 'toolbar' },
      h('button', { class: 'btn', type: 'button', onclick: () => { state.phase = 'idle'; state.error = ''; render(); } },
        '\u2190 Nova busca'),
      h('div', { class: 'stats' },
        h('span', { class: 'stat' }, countLabel),
        total ? h('span', { class: 'stat' }, itemCount + (itemCount === 1 ? ' item' : ' itens')) : null)));
    box.append(h('div', { class: 'fbar' },
      h('div', { class: 'tgroup', role: 'group', 'aria-label': 'Filtros' },
        h('span', { class: 'glabel' }, 'Filtros'), lsToggle('S\u00f3 completos', 'compara.onlyComplete', 'Mostra s\u00f3 mercados com todos os itens da lista')),
      h('div', { class: 'tgroup ia', role: 'group', 'aria-label': 'Escolha autom\u00e1tica' },
        h('span', { class: 'glabel' }, 'IA'), lsToggle('Jev', 'compara.jevOn', 'A Jev escolhe os produtos na pr\u00f3xima busca'))));
    for (let i = 0; i < visible.length; i++) box.append(marketCard(visible[i], i + 1));
    if (!total) {
      box.append(h('p', { class: 'muted' }, 'Nenhum mercado trouxe pre\u00e7os. Faz a busca de novo.'));
    } else if (!visible.length) {
      box.append(h('p', { class: 'muted' },
        'Ningu\u00e9m tem a lista toda. Tira o filtro \u201cS\u00f3 completos\u201d.'));
    }
    return box;
  }
  function cartView() {
    const c = state.cart || {};
    const box = h('div', { class: 'card view' });
    if (c.phase === 'loading') {
      box.append(h('div', { class: 'loading' },
        h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        h('div', {},
          h('p', { class: 'cart-step' }, c.detail || 'Montando o carrinho\u2026'),
          h('p', { class: 'muted' }, 'A p\u00e1gina navega sozinha e adiciona item por item.'))));
      return box;
    }
    const ok = c.added && c.added.length && !c.error;
    box.append(h('h3', { class: ok ? 'ok' : 'bad' },
      ok ? '\u2705 ' + c.added.length + (c.added.length === 1 ? ' item no carrinho' : ' itens no carrinho')
        : 'N\u00e3o deu pra montar o carrinho'));
    if (c.marketName) box.append(h('p', { class: 'muted' }, c.marketName));
    if (c.error) box.append(h('p', {}, c.error));
    const list = h('ul', { class: 'checklist' });
    for (const n of (c.added || [])) list.append(h('li', { class: 'ok' }, '\u2713 ' + n));
    for (const n of (c.failed || [])) list.append(h('li', { class: 'bad' }, '\u2717 ' + n));
    if (list.childNodes.length) box.append(list);
    if (ok) box.append(h('p', { class: 'muted' }, 'Confere no \u00edcone do carrinho do iFood e finaliza por l\u00e1.'));
    box.append(h('div', { class: 'form-row' },
      h('button', { class: 'btn', type: 'button', onclick: () => { state.phase = 'results'; render(); } },
        '\u2190 Voltar aos resultados'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { state.phase = 'idle'; state.error = ''; render(); } },
        'Nova busca')));
    return box;
  }
  function render() {
    const body = h('div', { class: 'body' });
    if (state.error) body.append(errorBanner());
    if (state.phase === 'idle') body.append(idleView());
    else if (state.phase === 'loading') body.append(loadingView());
    else if (state.phase === 'results') body.append(resultsView());
    else if (state.phase === 'cart') body.append(cartView());
    else body.append(idleView());
    panel.replaceChildren(body);
  }
})();
