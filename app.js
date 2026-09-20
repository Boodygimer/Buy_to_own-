/**
 * src/app.js  -  Mobile UI + player integration (Phase 3)
 *
 * Classic script, loaded last. Talks only to the Phase 1/2 services:
 *   Vault.ownership  shop, purchase, redeem, license checks, library
 *   Vault.media      vault caching (encrypt) and decrypt-for-playback leases
 *   Vault.db         init, storage estimate
 *
 * The UI mirrors the architecture, one step per verb:
 *   Buy / Redeem -> license granted         ("Owned")
 *   Download     -> encrypted vault copy    ("Saved on device")
 *   Play         -> license re-checked, decrypted in memory, URL revoked afterwards
 *
 * Icons are Lucide (ISC license) inlined below, so they work offline.
 * Only external runtime dependencies: Tailwind (CDN) and, for QR scanning on
 * browsers without BarcodeDetector, jsQR (CDN, loaded on demand).
 */
(function (global) {
  'use strict';

  const V = global.Vault;
  if (!V || !V.crypto || !V.db || !V.ownership || !V.media) {
    const target = document.getElementById('view');
    if (target) {
      target.innerHTML =
        '<div style="padding:24px"><h2>Scripts missing</h2><p>Load order: crypto.js, db.js, services/ownership.js, services/media.js, app.js.</p></div>';
    }
    return;
  }
  const db = V.db;
  const ownership = V.ownership;
  const media = V.media;

  // ===========================================================================
  // 1. Helpers
  // ===========================================================================

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtPrice(cents, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(cents / 100);
    } catch (_) {
      return '$' + (cents / 100).toFixed(2);
    }
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function fmtBytes(n) {
    if (!isFinite(n) || n <= 0) return '0 MB';
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
    return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB';
  }

  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  function friendlyError(e) {
    switch (e && e.code) {
      case 'INVALID_CODE': return "That code isn't valid. Check it and try again.";
      case 'CODE_ALREADY_REDEEMED': return 'That code has already been used.';
      case 'NOT_LICENSED': return "You don't have an active license for this item.";
      case 'NOT_CACHED': return "This item isn't saved on this device yet.";
      case 'VAULT_CORRUPT': return 'The saved copy is damaged. Download it again.';
      case 'NO_SUCH_PRODUCT': return 'This item is no longer in the catalog.';
      case 'UNSUPPORTED': return 'Secure storage needs HTTPS or localhost in a current browser.';
      default: return (e && e.message) || 'Something went wrong.';
    }
  }

  function stageLabel(stage, fraction) {
    switch (stage) {
      case 'checking': return 'Checking license...';
      case 'rendering': return 'Preparing audio ' + Math.round((fraction || 0) * 100) + '%';
      case 'encrypting': return 'Encrypting...';
      case 'saving': return 'Saving...';
      default: return 'Done';
    }
  }

  // ---------------------------------------------------------------------------
  // Icons (Lucide, ISC). Filled variants use fill="currentColor" on the shapes.
  // ---------------------------------------------------------------------------

  const ICONS = {
    play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
    'skip-back': '<polygon points="19 20 9 12 19 4 19 20" fill="currentColor"/><line x1="5" x2="5" y1="19" y2="5"/>',
    'skip-forward': '<polygon points="5 4 15 12 5 20 5 4" fill="currentColor"/><line x1="19" x2="19" y1="5" y2="19"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    'repeat-1': '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>',
    'volume-2': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    'volume-x': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
    'shopping-bag': '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
    'qr-code': '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    'list-plus': '<path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    keyboard: '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    'circle-check': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
    'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    'hard-drive': '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>'
  };

  function icon(name, size, cls) {
    const s = size || 24;
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + s + '" height="' + s +
      '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="' +
      (cls || '') + '" aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>'
    );
  }

  function coverImg(p, cls) {
    return '<img src="' + esc(p.cover_url) + '" alt="" draggable="false" class="' + cls + ' shrink-0 bg-neutral-800 object-cover">';
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------

  function toast(message, kind) {
    const root = $('#toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className =
      'pointer-events-auto max-w-sm rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ' +
      (kind === 'error' ? 'bg-red-600 text-white' : 'bg-neutral-100 text-neutral-900');
    el.style.cssText = 'padding:10px 16px;border-radius:12px;font-size:14px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.4);' +
      (kind === 'error' ? 'background:#dc2626;color:#fff' : 'background:#f4f4f5;color:#0a0a0a');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => {
      if (el.remove) el.remove();
    }, 3400);
  }

  // ===========================================================================
  // 2. State and data
  // ===========================================================================

  const state = {
    user: null,
    catalog: [],
    byId: {},
    library: [], // [{license, product, purchase}] newest first
    owned: new Set(), // product ids with an active license
    cached: new Set(), // product ids with an encrypted vault copy
    history: [], // purchases, newest first
    testCodes: [], // [{code, product_id, used}]
    storage: null,
    persistent: false,
    tab: 'shop',
    prevTab: 'library',
    busy: {} // productId -> progress text while downloading
  };

  let refreshTimer = null;

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshData().catch((err) => console.error('[app] refresh failed', err));
    }, 30);
  }

  async function refreshData() {
    const uid = state.user.id;
    const [catalog, library, cachedIds, history] = await Promise.all([
      ownership.getCatalog(),
      ownership.getLibrary({ userId: uid }),
      media.listCachedIds(),
      ownership.getPurchaseHistory({ userId: uid })
    ]);
    state.catalog = catalog;
    state.byId = {};
    catalog.forEach((p) => {
      state.byId[p.id] = p;
    });
    state.library = library;
    state.owned = new Set(library.map((i) => i.license.product_id));
    state.cached = new Set(cachedIds);
    state.history = history;

    state.testCodes = await Promise.all(
      db.TEST_ACTIVATION_CODES.map(async (c) => {
        const rec = await db.get(db.STORES.CODES, await V.crypto.hashActivationCode(c.code));
        return { code: c.code, product_id: c.product_id, used: !!(rec && rec.is_redeemed) };
      })
    );

    state.storage = await db.getStorageEstimate();
    try {
      state.persistent = !!(global.navigator.storage && (await global.navigator.storage.persisted()));
    } catch (_) {
      state.persistent = false;
    }
    render();
  }

  // ===========================================================================
  // 3. Views
  // ===========================================================================

  function header(title, subtitle, right) {
    return (
      '<header class="sticky top-0 z-10 bg-neutral-950/90 px-5 pb-3 pt-4 backdrop-blur" style="position:sticky;top:0;z-index:10;background:rgba(10,10,10,.92)">' +
      '<div class="flex items-start justify-between gap-3"><div>' +
      '<h1 class="text-2xl font-bold tracking-tight">' + esc(title) + '</h1>' +
      (subtitle ? '<p class="mt-0.5 text-sm text-neutral-400">' + esc(subtitle) + '</p>' : '') +
      '</div>' + (right || '') + '</div></header>'
    );
  }

  function emptyState(iconName, title, body, buttonHtml) {
    return (
      '<div class="mx-4 mt-6 rounded-2xl border border-dashed border-white/10 p-8 text-center">' +
      '<div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-neutral-400">' + icon(iconName, 24) + '</div>' +
      '<p class="font-semibold">' + esc(title) + '</p>' +
      '<p class="mt-1 text-sm text-neutral-400">' + esc(body) + '</p>' +
      (buttonHtml ? '<div class="mt-4">' + buttonHtml + '</div>' : '') +
      '</div>'
    );
  }

  // ---------------------------- Shop -----------------------------------------

  function shopView() {
    const cards = state.catalog
      .map((p) => {
        const owned = state.owned.has(p.id);
        const action = owned
          ? '<button class="btn btn-primary" data-action="play-product" data-id="' + esc(p.id) + '" aria-label="Play ' + esc(p.title) + '">' + icon('play', 14) + ' Play</button>'
          : '<button class="btn btn-light" data-action="buy" data-id="' + esc(p.id) + '" aria-label="Buy ' + esc(p.title) + ' for ' + esc(fmtPrice(p.price, p.currency)) + '">' + esc(fmtPrice(p.price, p.currency)) + '</button>';
        return (
          '<article class="flex gap-3 rounded-2xl bg-neutral-900 p-3">' +
          coverImg(p, 'h-20 w-20 rounded-xl') +
          '<div class="min-w-0 flex-1">' +
          '<h3 class="truncate font-semibold">' + esc(p.title) + '</h3>' +
          '<p class="truncate text-sm text-neutral-400">' + esc(p.artist) + ' \u00b7 ' + esc(p.album) + '</p>' +
          '<p class="mt-1 line-clamp-2 text-xs text-neutral-500">' + esc(p.description) + '</p>' +
          '</div>' +
          '<div class="flex shrink-0 flex-col items-end justify-between">' +
          '<span class="text-xs text-neutral-500">' + fmtTime(p.duration_sec) + '</span>' +
          (owned ? '<span class="chip bg-emerald-500/15 text-emerald-300">Owned</span>' : '') +
          action +
          '</div></article>'
        );
      })
      .join('');
    return (
      header('Store', 'Buy once. Own your access. Keep your music.') +
      '<div class="space-y-3 px-4 pb-6">' +
      (cards || emptyState('shopping-bag', 'The catalog is empty', 'Nothing is for sale right now.')) +
      '</div>'
    );
  }

  // ---------------------------- Library --------------------------------------

  function chipHtml(id) {
    if (state.busy[id]) {
      return '<span data-chip="' + esc(id) + '" class="chip bg-violet-500/20 text-violet-200">' + esc(state.busy[id]) + '</span>';
    }
    if (state.cached.has(id)) {
      return '<span data-chip="' + esc(id) + '" class="chip bg-emerald-500/15 text-emerald-300">Saved on device</span>';
    }
    return '<span data-chip="' + esc(id) + '" class="chip bg-amber-500/15 text-amber-300">Not downloaded</span>';
  }

  function libraryView() {
    const items = state.library.filter((i) => i.product);
    const ready = items.filter((i) => state.cached.has(i.license.product_id)).length;
    const playId = currentId();

    const rows = items
      .map((item) => {
        const p = item.product;
        const cached = state.cached.has(p.id);
        const isCurrent = playId === p.id;
        const storageBtn = cached
          ? '<button class="icon-btn" data-action="evict" data-id="' + esc(p.id) + '" aria-label="Remove downloaded copy of ' + esc(p.title) + '">' + icon('trash-2', 20) + '</button>'
          : '<button class="icon-btn" data-action="download" data-id="' + esc(p.id) + '" aria-label="Download ' + esc(p.title) + '">' + icon('download', 20) + '</button>';
        return (
          '<li class="flex items-center gap-1 rounded-2xl bg-neutral-900 p-2">' +
          '<button class="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left" data-action="play-product" data-id="' + esc(p.id) + '" aria-label="Play ' + esc(p.title) + '">' +
          coverImg(p, 'h-14 w-14 rounded-lg') +
          '<span class="min-w-0"><span class="block truncate font-medium ' + (isCurrent ? 'text-violet-300' : '') + '">' + esc(p.title) + '</span>' +
          '<span class="block truncate text-sm text-neutral-400">' + esc(p.artist) + '</span>' +
          '<span class="mt-1 block">' + chipHtml(p.id) + '</span></span></button>' +
          '<button class="icon-btn" data-action="enqueue" data-id="' + esc(p.id) + '" aria-label="Add ' + esc(p.title) + ' to queue">' + icon('list-plus', 20) + '</button>' +
          storageBtn +
          '</li>'
        );
      })
      .join('');

    const history = state.history
      .map((h) => {
        const p = state.byId[h.product_id];
        return (
          '<li class="flex items-start justify-between gap-3 py-2 text-sm">' +
          '<div class="min-w-0"><p class="truncate">' + esc(p ? p.title : h.product_id) + '</p>' +
          '<p class="truncate text-xs text-neutral-500">' + esc(h.transaction_ref) + ' \u00b7 ' + esc(fmtDate(h.timestamp)) + '</p></div>' +
          '<span class="shrink-0 text-neutral-300">' + (h.method === 'activation_code' ? 'Code' : esc(fmtPrice(h.amount, h.currency))) + '</span></li>'
        );
      })
      .join('');

    let storageLine = '';
    if (state.storage) {
      storageLine =
        icon('hard-drive', 14) + ' App storage: ' + fmtBytes(state.storage.usage) +
        (state.storage.quota ? ' of ' + fmtBytes(state.storage.quota) : '') +
        ' \u00b7 Kept when space is low: ' + (state.persistent ? 'yes' : 'not guaranteed');
    }

    const body = items.length
      ? '<div class="flex gap-2 px-4 pb-3"><button class="btn btn-primary" data-action="play-all">' + icon('play', 14) + ' Play all</button></div>' +
        '<ul class="space-y-2 px-4">' + rows + '</ul>'
      : emptyState('library', 'Your library is empty', 'Buy a track or redeem a code and it will appear here.',
          '<button class="btn btn-primary" data-action="nav" data-tab="shop">Browse the store</button>');

    return (
      header('My Library', items.length ? items.length + (items.length === 1 ? ' track' : ' tracks') + ' \u00b7 ' + ready + ' saved on device' : 'Everything you own lives here') +
      body +
      '<details class="mx-4 mt-6 rounded-2xl bg-neutral-900 px-4 py-3"><summary class="flex items-center justify-between text-sm font-semibold">Purchase history<span class="text-neutral-500">' + state.history.length + '</span></summary>' +
      (history ? '<ul class="mt-2 divide-y divide-white/5">' + history + '</ul>' : '<p class="mt-2 text-sm text-neutral-500">No purchases yet.</p>') +
      '</details>' +
      (storageLine ? '<p class="flex items-center gap-1.5 px-5 pb-8 pt-4 text-xs text-neutral-500">' + storageLine + '</p>' : '<div class="pb-8"></div>')
    );
  }

  // ---------------------------- Redeem ---------------------------------------

  function redeemView() {
    const codes = state.testCodes
      .map((c) => {
        const p = state.byId[c.product_id];
        return (
          '<li><button class="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left ' + (c.used ? 'opacity-40' : 'bg-white/5') + '"' +
          (c.used ? ' disabled' : ' data-action="open-redeem" data-mode="type" data-code="' + esc(c.code) + '"') + '>' +
          '<span class="min-w-0"><span class="block font-mono text-sm tracking-wider">' + esc(c.code) + '</span>' +
          '<span class="block truncate text-xs text-neutral-400">' + esc(p ? p.title : c.product_id) + '</span></span>' +
          '<span class="text-xs text-neutral-400">' + (c.used ? 'used' : 'tap to fill') + '</span></button></li>'
        );
      })
      .join('');
    return (
      header('Redeem', 'Unlock music with a code or QR card') +
      '<div class="px-4 pb-8">' +
      '<div class="rounded-3xl bg-gradient-to-br from-violet-600/30 to-fuchsia-600/10 p-6 text-center" style="background:linear-gradient(135deg,rgba(124,58,237,.3),rgba(192,38,211,.1))">' +
      '<div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10">' + icon('qr-code', 32) + '</div>' +
      '<p class="text-lg font-semibold">Got a code?</p>' +
      '<p class="mx-auto mt-1 max-w-xs text-sm text-neutral-300">Scan the QR on your card or type the code. Codes work once and are checked offline.</p>' +
      '<div class="mt-5 flex flex-col gap-2">' +
      '<button class="btn btn-primary" data-action="open-redeem" data-mode="scan">' + icon('camera', 18) + ' Scan QR code</button>' +
      '<button class="btn btn-ghost" data-action="open-redeem" data-mode="type">' + icon('keyboard', 18) + ' Type a code</button>' +
      '</div></div>' +
      '<details class="mt-6 rounded-2xl bg-neutral-900 px-4 py-3"><summary class="text-sm font-semibold">MVP test codes</summary>' +
      '<p class="mt-2 text-xs text-neutral-500">Only for this local demo. Each one works once.</p>' +
      '<ul class="mt-2 space-y-1.5">' + codes + '</ul></details>' +
      '</div>'
    );
  }

  // ---------------------------- Now playing ----------------------------------

  function nowPlayingView() {
    const p = currentProduct();
    if (!p) {
      return (
        '<div class="px-4 pt-4"><button class="icon-btn" data-action="np-back" aria-label="Close">' + icon('chevron-down', 26) + '</button></div>' +
        emptyState('music', 'Nothing playing', 'Pick something from your library to start.',
          '<button class="btn btn-primary" data-action="nav" data-tab="library">Open library</button>')
      );
    }

    const queue = player.queue
      .map((id, i) => {
        const q = state.byId[id];
        if (!q) return '';
        const active = i === player.index;
        return (
          '<li class="flex items-center gap-1 rounded-xl ' + (active ? 'bg-white/10' : '') + ' p-1.5">' +
          '<button class="flex min-w-0 flex-1 items-center gap-3 text-left" data-action="queue-jump" data-index="' + i + '" aria-label="Play ' + esc(q.title) + '">' +
          coverImg(q, 'h-10 w-10 rounded-md') +
          '<span class="min-w-0"><span class="block truncate text-sm ' + (active ? 'font-semibold text-violet-300' : '') + '">' + esc(q.title) + '</span>' +
          '<span class="block truncate text-xs text-neutral-400">' + esc(q.artist) + '</span></span></button>' +
          '<button class="icon-btn" style="width:36px;height:36px" data-action="queue-remove" data-index="' + i + '" aria-label="Remove ' + esc(q.title) + ' from queue">' + icon('x', 16) + '</button></li>'
        );
      })
      .join('');

    const dur = getDuration();
    const cur = player.loaded ? audio.currentTime : 0;
    const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
    const vol = Math.round((audio.muted ? 0 : audio.volume) * 100);

    return (
      '<section class="flex min-h-full flex-col px-5 pb-8 pt-2">' +
      '<div class="flex items-center justify-between"><button class="icon-btn" data-action="np-back" aria-label="Close player">' + icon('chevron-down', 26) + '</button>' +
      '<span class="text-xs font-semibold uppercase tracking-widest text-neutral-400">Now playing</span><span style="width:44px"></span></div>' +
      '<div class="mx-auto mt-3 w-full" style="max-width:20rem">' + coverImg(p, 'aspect-square w-full rounded-3xl shadow-2xl') + '</div>' +
      '<div class="mt-6 text-center"><h2 class="truncate text-xl font-bold">' + esc(p.title) + '</h2>' +
      '<p class="truncate text-neutral-400" data-role="subtitle">' + esc(subtitleText()) + '</p>' +
      '<p class="truncate text-xs text-neutral-500">' + esc(p.album) + '</p></div>' +
      '<div class="mt-4"><input id="np-seek" class="seek" type="range" min="0" max="1000" step="1" value="' + Math.round(pct * 10) + '" style="--p:' + pct + '%" aria-label="Seek">' +
      '<div class="mt-1 flex justify-between text-xs tabular-nums text-neutral-400"><span id="np-cur">' + fmtTime(cur) + '</span><span id="np-dur">' + fmtTime(dur) + '</span></div></div>' +
      '<div class="mt-2 flex items-center justify-between">' +
      '<button class="icon-btn" data-action="loop" data-role="loop" aria-label="Repeat"></button>' +
      '<button class="icon-btn" data-action="prev" aria-label="Previous">' + icon('skip-back', 28) + '</button>' +
      '<button class="flex h-16 w-16 items-center justify-center rounded-full bg-white text-neutral-900" style="width:64px;height:64px;border:0;border-radius:9999px;background:#fff;color:#0a0a0a;display:inline-flex;align-items:center;justify-content:center" data-action="toggle-play" data-role="playpause" data-size="30" aria-label="Play"></button>' +
      '<button class="icon-btn" data-action="next" aria-label="Next">' + icon('skip-forward', 28) + '</button>' +
      '<button class="icon-btn" data-action="mute" data-role="mute" aria-label="Mute"></button></div>' +
      (volumeSupported
        ? '<div class="mt-2 flex items-center gap-2"><span class="text-neutral-500">' + icon('volume-2', 16) + '</span><input id="np-vol" class="seek" type="range" min="0" max="100" step="1" value="' + vol + '" style="--p:' + vol + '%" aria-label="Volume"></div>'
        : '') +
      '<div class="mt-6 flex items-center justify-between"><h3 class="text-sm font-semibold">Queue <span class="text-neutral-500">' + player.queue.length + '</span></h3>' +
      '<button class="btn btn-ghost" style="min-height:32px;padding:.25rem .75rem" data-action="queue-clear">Clear</button></div>' +
      '<ul class="mt-2 space-y-1">' + queue + '</ul></section>'
    );
  }

  const VIEWS = { shop: shopView, library: libraryView, redeem: redeemView, now: nowPlayingView };

  // ---------------------------- Chrome ---------------------------------------

  let lastTab = null;

  function render() {
    const view = $('#view');
    if (!view) return;
    const keep = lastTab === state.tab ? view.scrollTop : 0;
    view.innerHTML = (VIEWS[state.tab] || shopView)();
    view.scrollTop = keep;
    lastTab = state.tab;
    renderNav();
    renderMini();
    syncPlayerUI();
  }

  function renderNav() {
    const items = [
      ['shop', 'Shop', 'shopping-bag'],
      ['library', 'Library', 'library'],
      ['redeem', 'Redeem', 'qr-code'],
      ['now', 'Now Playing', 'music']
    ];
    $('#nav').innerHTML =
      '<div class="grid grid-cols-4" style="display:grid;grid-template-columns:repeat(4,1fr)">' +
      items
        .map(([tab, label, ic]) => {
          const active = state.tab === tab;
          const dot = tab === 'now' && player.status === 'playing'
            ? '<span class="absolute animate-pulse rounded-full bg-violet-400" style="top:6px;right:calc(50% - 16px);width:8px;height:8px"></span>'
            : '';
          return (
            '<button class="relative flex flex-col items-center gap-0.5 py-2 text-xs ' + (active ? 'text-violet-300' : 'text-neutral-400') + '" style="background:transparent;border:0;display:flex;flex-direction:column;align-items:center" data-action="nav" data-tab="' + tab + '"' +
            (active ? ' aria-current="page"' : '') + '>' + icon(ic, 22) + '<span>' + label + '</span>' + dot + '</button>'
          );
        })
        .join('') +
      '</div>';
  }

  function renderMini() {
    const root = $('#mini');
    if (!root) return;
    const p = currentProduct();
    if (!p || state.tab === 'now') {
      root.innerHTML = '';
      return;
    }
    root.innerHTML =
      '<div class="mx-2 mb-2 overflow-hidden rounded-2xl border border-white/5 bg-neutral-800/95 shadow-xl backdrop-blur" style="margin:0 8px 8px;background:rgba(38,38,38,.96);border-radius:16px;overflow:hidden">' +
      '<div class="flex items-center gap-1 p-2" style="display:flex;align-items:center">' +
      '<button class="flex min-w-0 flex-1 items-center gap-3 text-left" style="background:transparent;border:0;color:inherit;display:flex;align-items:center;min-width:0;flex:1;text-align:left" data-action="mini-open" aria-label="Open player">' +
      coverImg(p, 'h-11 w-11 rounded-lg') +
      '<span class="min-w-0" style="min-width:0"><span class="block truncate text-sm font-medium" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.title) + '</span>' +
      '<span class="block truncate text-xs text-neutral-400" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#a3a3a3" data-role="subtitle">' + esc(subtitleText()) + '</span></span></button>' +
      '<button class="icon-btn" data-action="toggle-play" data-role="playpause" data-size="24" aria-label="Play"></button>' +
      '<button class="icon-btn" data-action="next" aria-label="Next">' + icon('skip-forward', 22) + '</button></div>' +
      '<div style="height:2px;background:rgba(255,255,255,.1)"><div data-role="mini-bar" style="height:100%;width:0%;background:#a78bfa"></div></div></div>';
  }

  // ===========================================================================
  // 4. Modal system
  // ===========================================================================

  const modal = { id: 0, onClose: null };

  function openModal(inner, options) {
    closeModal();
    const opts = options || {};
    modal.id += 1;
    modal.onClose = opts.onClose || null;
    $('#modal-root').innerHTML =
      '<div id="modal-backdrop" class="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm" style="position:fixed;inset:0;z-index:50;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.7)">' +
      '<div id="modal-card" role="dialog" aria-modal="true" aria-label="' + esc(opts.label || 'Dialog') + '" class="w-full max-w-md overflow-y-auto rounded-t-3xl bg-neutral-900 p-5 shadow-2xl" ' +
      'style="width:100%;max-width:28rem;max-height:92vh;max-height:92dvh;overflow-y:auto;background:#171717;border-radius:24px 24px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom, 0px))">' +
      inner + '</div></div>';
    document.body.classList.add('overflow-hidden');
    return modal.id;
  }

  function setModalBody(html, id) {
    if (id !== undefined && id !== modal.id) return;
    const card = $('#modal-card');
    if (card) card.innerHTML = html;
  }

  function closeModal() {
    if (!$('#modal-card')) return;
    const cb = modal.onClose;
    modal.onClose = null;
    modal.id += 1;
    $('#modal-root').innerHTML = '';
    document.body.classList.remove('overflow-hidden');
    if (cb) {
      try {
        cb();
      } catch (_) {
        /* ignore */
      }
    }
  }

  // ---------------------------- Acquisition (purchase / redeem result) --------

  let acq = null;
  let purchaseCtx = null;

  function stepIcon(stateName) {
    if (stateName === 'done') return '<span style="color:#34d399">' + icon('circle-check', 20) + '</span>';
    if (stateName === 'active') return '<span style="color:#a78bfa">' + icon('loader', 20, 'spin') + '</span>';
    if (stateName === 'error') return '<span style="color:#f87171">' + icon('alert-triangle', 20) + '</span>';
    return '<span style="color:#525252">' + icon('circle', 20) + '</span>';
  }

  function acquisitionHtml(a) {
    const p = a.product;
    const rows = a.labels
      .map((label, i) => {
        const s = a.steps[i];
        return (
          '<li class="flex items-start gap-3"><span class="mt-0.5 shrink-0">' + stepIcon(s.state) + '</span>' +
          '<span class="min-w-0"><span class="block text-sm ' + (s.state === 'pending' ? 'text-neutral-500' : 'text-neutral-100') + '">' + esc(label) + '</span>' +
          (s.text ? '<span class="block text-xs ' + (s.state === 'error' ? 'text-red-400' : 'text-neutral-500') + '">' + esc(s.text) + '</span>' : '') +
          '</span></li>'
        );
      })
      .join('');
    let buttons;
    if (a.finished && a.ok) {
      buttons = '<button class="btn btn-primary flex-1" style="flex:1" data-action="acq-play">' + icon('play', 16) + ' Play now</button><button class="btn btn-ghost" data-action="close-modal">Done</button>';
    } else if (a.finished && a.canRetry) {
      buttons = '<button class="btn btn-primary flex-1" style="flex:1" data-action="acq-retry">' + icon('download', 16) + ' Try again</button><button class="btn btn-ghost" data-action="close-modal">Close</button>';
    } else if (a.finished) {
      buttons = '<button class="btn btn-ghost flex-1" style="flex:1" data-action="close-modal">Close</button>';
    } else {
      buttons = '<button class="btn btn-ghost flex-1" style="flex:1" data-action="close-modal">Hide</button>';
    }
    return (
      '<div class="flex items-center gap-3">' + coverImg(p, 'h-16 w-16 rounded-xl') +
      '<div class="min-w-0"><p class="truncate font-semibold">' + esc(p.title) + '</p>' +
      '<p class="truncate text-sm text-neutral-400">' + esc(p.artist) + '</p></div></div>' +
      '<h2 class="mt-4 text-lg font-bold" aria-live="polite">' + esc(a.headline) + '</h2>' +
      '<ol class="mt-3 space-y-3" style="list-style:none;padding:0">' + rows + '</ol>' +
      '<div class="mt-5 flex gap-2" style="display:flex;gap:8px">' + buttons + '</div>'
    );
  }

  /**
   * Shows the three-step pipeline: grant (payment/code) -> license -> encrypted vault.
   * Resolves true when everything succeeded, false otherwise (errors are drawn in the sheet).
   */
  async function runAcquisition(opts) {
    const product = opts.product;
    const kind = opts.kind;
    const mid = opts.mid || openModal('', { label: 'Adding ' + product.title });
    const labels = [kind === 'code' ? 'Code verified' : 'Payment recorded', 'License granted', 'Saved to encrypted vault'];
    const steps = [{ state: 'active', text: '' }, { state: 'pending', text: '' }, { state: 'pending', text: '' }];
    acq = { product: product, retry: null };
    const draw = (extra) => setModalBody(acquisitionHtml(Object.assign({ product: product, labels: labels, steps: steps }, extra)), mid);

    draw({ headline: kind === 'code' ? 'Checking your code...' : 'Processing payment...' });

    let granted;
    try {
      granted = await opts.grant();
    } catch (e) {
      steps[0] = { state: 'error', text: friendlyError(e) };
      draw({ headline: "That didn't go through", finished: true });
      return false;
    }
    steps[0] = { state: 'done', text: granted.purchase.transaction_ref };
    steps[1] = { state: 'done', text: 'Key ending ' + granted.license.license_key.slice(-4) };
    scheduleRefresh();

    const saveToVault = async () => {
      steps[2] = { state: 'active', text: 'Starting...' };
      draw({ headline: 'Saving to your vault...' });
      try {
        await media.cacheProduct({
          userId: state.user.id,
          productId: product.id,
          onProgress: (stage, fraction) => {
            steps[2].text = stageLabel(stage, fraction);
            draw({ headline: 'Saving to your vault...' });
          }
        });
        steps[2] = { state: 'done', text: 'Encrypted with AES-256-GCM' };
        draw({ headline: "It's yours.", finished: true, ok: true });
        return true;
      } catch (e) {
        steps[2] = { state: 'error', text: friendlyError(e) };
        draw({ headline: 'Owned, but not saved yet', finished: true, canRetry: true });
        return false;
      }
    };
    acq.retry = saveToVault;
    return saveToVault();
  }

  // ---------------------------- Purchase -------------------------------------

  function purchaseHtml(p) {
    const bullet = (text) => '<li class="flex items-start gap-2"><span style="color:#34d399">' + icon('check', 16) + '</span><span>' + text + '</span></li>';
    return (
      '<div class="flex items-center justify-between"><h2 class="text-lg font-bold">Buy once, own it</h2>' +
      '<button class="icon-btn" data-action="close-modal" aria-label="Close">' + icon('x') + '</button></div>' +
      '<div class="mt-4 flex items-center gap-3">' + coverImg(p, 'h-20 w-20 rounded-xl') +
      '<div class="min-w-0"><p class="truncate font-semibold">' + esc(p.title) + '</p>' +
      '<p class="truncate text-sm text-neutral-400">' + esc(p.artist) + '</p>' +
      '<p class="mt-1 text-xl font-bold">' + esc(fmtPrice(p.price, p.currency)) + '</p></div></div>' +
      '<ul class="mt-4 space-y-2 text-sm text-neutral-300" style="list-style:none;padding:0">' +
      bullet('One payment, no subscription') +
      bullet('A permanent license stays on this device') +
      bullet('Saved encrypted in your vault for offline play') + '</ul>' +
      '<p class="mt-3 text-xs text-neutral-500">Simulated payment for this MVP. Nothing is charged.</p>' +
      '<div class="mt-5 flex gap-2" style="display:flex;gap:8px"><button class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
      '<button class="btn btn-primary" style="flex:1" data-action="buy-confirm">Buy for ' + esc(fmtPrice(p.price, p.currency)) + '</button></div>'
    );
  }

  function startPurchase(id) {
    const p = state.byId[id];
    if (!p) return;
    if (state.owned.has(id)) {
      toast('You already own this.');
      return;
    }
    const mid = openModal(purchaseHtml(p), { label: 'Buy ' + p.title });
    purchaseCtx = { product: p, mid: mid };
  }

  function confirmPurchase() {
    if (!purchaseCtx) return undefined;
    const ctx = purchaseCtx;
    purchaseCtx = null;
    return runAcquisition({
      product: ctx.product,
      mid: ctx.mid,
      kind: 'purchase',
      grant: () => ownership.purchase({ userId: state.user.id, productId: ctx.product.id, simulateDelayMs: 700 })
    });
  }

  // ===========================================================================
  // 5. Redeem modal + QR scanner
  // ===========================================================================

  const Scanner = (function () {
    let stream = null;
    let timer = null;
    let running = false;
    let detector = null;
    let canvas = null;
    let jsqrPromise = null;

    async function getDetector() {
      if (detector) return detector;
      if (typeof global.BarcodeDetector === 'function') {
        try {
          const formats = await global.BarcodeDetector.getSupportedFormats();
          if (formats.indexOf('qr_code') !== -1) {
            detector = new global.BarcodeDetector({ formats: ['qr_code'] });
            return detector;
          }
        } catch (_) {
          /* fall back to jsQR */
        }
      }
      return null;
    }

    function loadJsQR() {
      if (global.jsQR) return Promise.resolve(global.jsQR);
      if (!jsqrPromise) {
        jsqrPromise = new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
          s.onload = () => (global.jsQR ? resolve(global.jsQR) : reject(new Error('The QR decoder failed to start.')));
          s.onerror = () => {
            jsqrPromise = null;
            reject(new Error('Could not load the QR decoder (are you offline?). Type the code instead.'));
          };
          document.head.appendChild(s);
        });
      }
      return jsqrPromise;
    }

    async function decode(source, w, h) {
      const det = await getDetector();
      if (det) {
        const found = await det.detect(source);
        return found.length ? found[0].rawValue : null;
      }
      const jsQR = await loadJsQR();
      const scale = Math.min(1, 640 / w);
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      canvas = canvas || document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, cw, ch);
      const img = ctx.getImageData(0, 0, cw, ch);
      const result = jsQR(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
      return result ? result.data : null;
    }

    function stop() {
      running = false;
      clearTimeout(timer);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      const v = $('#rd-video');
      if (v) v.srcObject = null;
    }

    async function start(video, onText, onStatus) {
      stop();
      if (!global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera access needs HTTPS or localhost in a browser that supports it.');
      }
      stream = await global.navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      video.srcObject = stream;
      video.muted = true;
      video.setAttribute('playsinline', '');
      await video.play();
      running = true;
      const tick = async () => {
        if (!running) return;
        try {
          if (video.readyState >= 2 && video.videoWidth) {
            const text = await decode(video, video.videoWidth, video.videoHeight);
            if (text && running) onText(text);
          }
        } catch (err) {
          if (running) onStatus(err.message);
          if (err && /decoder/i.test(err.message)) {
            stop();
            return;
          }
        }
        if (running) timer = setTimeout(tick, 220);
      };
      tick();
    }

    async function scanImage(file) {
      const bmp = await global.createImageBitmap(file);
      try {
        return await decode(bmp, bmp.width, bmp.height);
      } finally {
        if (bmp.close) bmp.close();
      }
    }

    return { start: start, stop: stop, scanImage: scanImage };
  })();

  let redeemBusy = false;

  function redeemModalHtml(prefill) {
    return (
      '<div class="flex items-center justify-between"><h2 class="text-lg font-bold">Redeem a code</h2>' +
      '<button class="icon-btn" data-action="close-modal" aria-label="Close">' + icon('x') + '</button></div>' +
      '<div class="mt-3 grid grid-cols-2 gap-1 rounded-full bg-neutral-800 p-1" style="display:grid;grid-template-columns:1fr 1fr;gap:4px;background:#262626;border-radius:9999px;padding:4px" role="tablist">' +
      '<button id="rd-tab-scan" role="tab" class="btn" data-action="rd-mode" data-mode="scan">' + icon('camera', 16) + ' Scan</button>' +
      '<button id="rd-tab-type" role="tab" class="btn" data-action="rd-mode" data-mode="type">' + icon('keyboard', 16) + ' Type</button></div>' +
      '<div id="rd-scan-pane" class="mt-4">' +
      '<div class="relative aspect-square w-full overflow-hidden rounded-2xl bg-black" style="position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;border-radius:16px;background:#000">' +
      '<video id="rd-video" playsinline muted style="width:100%;height:100%;object-fit:cover"></video>' +
      '<div class="scan-frame"><i></i><i></i><i></i><i></i></div></div>' +
      '<p id="rd-scan-status" class="mt-3 text-center text-sm text-neutral-400" aria-live="polite"></p>' +
      '<label class="btn btn-ghost mt-3 w-full" style="width:100%;margin-top:12px">' + icon('image', 16) + ' Scan from a photo' +
      '<input id="rd-file" type="file" accept="image/*" class="hidden"></label></div>' +
      '<div id="rd-type-pane" class="mt-4 hidden">' +
      '<label for="rd-input" class="text-sm text-neutral-400">Activation code</label>' +
      '<input id="rd-input" type="text" value="' + esc(prefill || '') + '" placeholder="XXXX-XXXX-XXXX" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" ' +
      'class="mt-1 w-full rounded-xl border border-white/10 bg-neutral-800 px-4 py-3 text-lg uppercase tracking-widest" ' +
      'style="width:100%;box-sizing:border-box;margin-top:4px;padding:12px 16px;font-size:18px;letter-spacing:.1em;text-transform:uppercase;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:#262626;color:inherit">' +
      '<button id="rd-submit" class="btn btn-primary mt-3 w-full" style="width:100%;margin-top:12px" data-action="rd-submit">Redeem</button></div>' +
      '<div id="rd-result" class="mt-3" aria-live="polite"></div>'
    );
  }

  function setScanStatus(text, isError) {
    const el = $('#rd-scan-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#f87171' : '';
  }

  function setResult(message, kind, extraHtml) {
    const el = $('#rd-result');
    if (!el) return;
    if (!message) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML =
      '<div class="rounded-xl p-3 text-sm" style="padding:12px;border-radius:12px;font-size:14px;background:' +
      (kind === 'error' ? 'rgba(220,38,38,.15);color:#fca5a5' : 'rgba(255,255,255,.08)') + '">' + esc(message) + (extraHtml || '') + '</div>';
  }

  let redeemMode = 'scan';

  function setRedeemMode(mode) {
    redeemMode = mode;
    const scan = $('#rd-scan-pane');
    const type = $('#rd-type-pane');
    if (!scan || !type) return;
    scan.classList.toggle('hidden', mode !== 'scan');
    type.classList.toggle('hidden', mode !== 'type');
    ['scan', 'type'].forEach((m) => {
      const tab = $('#rd-tab-' + m);
      if (!tab) return;
      tab.classList.toggle('btn-primary', m === mode);
      tab.setAttribute('aria-selected', String(m === mode));
    });
    setResult('');
    if (mode === 'scan') {
      startScanner();
    } else {
      Scanner.stop();
      const input = $('#rd-input');
      if (input && input.focus) input.focus();
    }
  }

  function scanErrorMessage(e) {
    if (e && e.name === 'NotAllowedError') return 'Camera permission was denied. Allow it in your browser settings, or type the code.';
    if (e && e.name === 'NotFoundError') return 'No camera found on this device. Type the code instead.';
    return (e && e.message) || 'The camera could not be started.';
  }

  async function startScanner() {
    const video = $('#rd-video');
    if (!video) return;
    setScanStatus('Starting camera...');
    try {
      await Scanner.start(video, onScanText, (msg) => setScanStatus(msg, true));
      setScanStatus('Point the camera at the QR code');
    } catch (e) {
      setScanStatus(scanErrorMessage(e), true);
    }
  }

  async function onScanText(text) {
    if (redeemBusy) return;
    const code = ownership.parseScannedPayload(text);
    if (!code) {
      setScanStatus("That QR code isn't an activation code.", true);
      return;
    }
    Scanner.stop();
    await redeemFlow(code);
  }

  async function redeemFlow(rawCode) {
    if (redeemBusy) return;
    redeemBusy = true;
    const mid = modal.id;
    const button = $('#rd-submit');
    setResult('');
    if (button) {
      button.disabled = true;
      button.textContent = 'Checking...';
    }
    try {
      const granted = await ownership.redeemCode({ userId: state.user.id, code: rawCode });
      if (global.navigator.vibrate) global.navigator.vibrate(30);
      redeemBusy = false;
      await runAcquisition({ product: granted.product, mid: mid, kind: 'code', grant: async () => granted });
    } catch (e) {
      redeemBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent = 'Redeem';
      }
      setResult(
        friendlyError(e),
        'error',
        redeemMode === 'scan' ? ' <button class="btn btn-ghost" style="margin-left:8px;min-height:32px" data-action="rd-rescan">Scan again</button>' : ''
      );
    } finally {
      redeemBusy = false;
    }
  }

  function openRedeemModal(mode, prefill) {
    openModal(redeemModalHtml(prefill), { label: 'Redeem a code', onClose: () => Scanner.stop() });
    setRedeemMode(mode === 'type' ? 'type' : 'scan');
  }

  function submitTypedCode() {
    const input = $('#rd-input');
    const value = input ? input.value : '';
    if (!String(value).trim()) {
      setResult('Enter your code first.', 'error');
      return undefined;
    }
    return redeemFlow(value);
  }

  // ===========================================================================
  // 6. Player
  // ===========================================================================

  const volumeSupported = (function () {
    try {
      const probe = new global.Audio();
      probe.volume = 0.5;
      return probe.volume === 0.5;
    } catch (_) {
      return false;
    }
  })();

  const audio = new global.Audio();
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  audio.style.display = 'none';
  if (document.body) document.body.appendChild(audio);

  const player = {
    queue: [], // product ids
    index: -1,
    status: 'idle', // idle | paused | loading | playing
    loop: 'off', // off | all | one
    loaded: false, // audio element holds the current track
    lease: null,
    token: 0,
    loadingText: ''
  };

  let scrubbing = false;

  function currentId() {
    return player.index >= 0 ? player.queue[player.index] || null : null;
  }

  function currentProduct() {
    const id = currentId();
    return id ? state.byId[id] || null : null;
  }

  function subtitleText() {
    const p = currentProduct();
    if (player.status === 'loading') return player.loadingText || 'Preparing...';
    return p ? p.artist : '';
  }

  function getDuration() {
    const d = audio.duration;
    if (isFinite(d) && d > 0) return d;
    const p = currentProduct();
    return (player.lease && player.lease.durationSec) || (p && p.duration_sec) || 0;
  }

  // ---------------------------- Preferences ----------------------------------

  const PREF_KEY = 'own.prefs.v1';

  function readPrefs() {
    try {
      return JSON.parse(global.localStorage.getItem(PREF_KEY)) || {};
    } catch (_) {
      return {};
    }
  }

  function writePrefs() {
    try {
      global.localStorage.setItem(
        PREF_KEY,
        JSON.stringify({ volume: audio.volume, loop: player.loop, queue: player.queue, index: player.index })
      );
    } catch (_) {
      /* storage may be unavailable; preferences are optional */
    }
  }

  function restorePrefs() {
    const prefs = readPrefs();
    if (prefs.loop === 'all' || prefs.loop === 'one') player.loop = prefs.loop;
    audio.loop = player.loop === 'one';
    if (typeof prefs.volume === 'number' && volumeSupported) audio.volume = Math.max(0, Math.min(1, prefs.volume));
    const saved = Array.isArray(prefs.queue) ? prefs.queue : [];
    const wanted = saved[prefs.index];
    player.queue = saved.filter((id) => state.owned.has(id));
    const at = player.queue.indexOf(wanted);
    player.index = at >= 0 ? at : player.queue.length ? 0 : -1;
    player.status = player.queue.length ? 'paused' : 'idle';
  }

  // ---------------------------- UI sync --------------------------------------

  function syncPlayerUI() {
    const loading = player.status === 'loading';
    const playing = player.status === 'playing';
    $$('[data-role="playpause"]').forEach((btn) => {
      const size = Number(btn.getAttribute('data-size')) || 24;
      btn.innerHTML = loading ? icon('loader', size, 'spin') : icon(playing ? 'pause' : 'play', size);
      btn.setAttribute('aria-label', loading ? 'Loading' : playing ? 'Pause' : 'Play');
    });
    $$('[data-role="loop"]').forEach((btn) => {
      btn.innerHTML = icon(player.loop === 'one' ? 'repeat-1' : 'repeat', 22);
      btn.classList.toggle('on', player.loop !== 'off');
      btn.setAttribute('aria-label', 'Repeat: ' + player.loop);
    });
    $$('[data-role="mute"]').forEach((btn) => {
      const silent = audio.muted || audio.volume === 0;
      btn.innerHTML = icon(silent ? 'volume-x' : 'volume-2', 22);
      btn.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
    });
    $$('[data-role="subtitle"]').forEach((el) => {
      el.textContent = subtitleText();
    });
    updateTimeUI();
  }

  function updateTimeUI() {
    const dur = getDuration();
    const cur = player.loaded ? audio.currentTime || 0 : 0;
    const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
    $$('[data-role="mini-bar"]').forEach((el) => {
      el.style.width = pct + '%';
    });
    if (!scrubbing) {
      const seek = $('#np-seek');
      if (seek) {
        seek.value = String(Math.round(pct * 10));
        seek.style.setProperty('--p', pct + '%');
      }
      const c = $('#np-cur');
      if (c) c.textContent = fmtTime(cur);
    }
    const d = $('#np-dur');
    if (d) d.textContent = fmtTime(dur);
  }

  function sync() {
    syncPlayerUI();
    renderNav();
    MS.setState(player.status === 'playing' ? 'playing' : player.status === 'idle' ? 'none' : 'paused');
  }

  // ---------------------------- Media Session --------------------------------

  const MS = (function () {
    const ok = 'mediaSession' in global.navigator;
    const artCache = {};
    let lastPosition = 0;

    function coverPng(p) {
      if (!artCache[p.id]) {
        artCache[p.id] = new Promise((resolve) => {
          try {
            const img = new global.Image();
            img.onload = () => {
              try {
                const c = document.createElement('canvas');
                c.width = 512;
                c.height = 512;
                c.getContext('2d').drawImage(img, 0, 0, 512, 512);
                resolve(c.toDataURL('image/png'));
              } catch (_) {
                resolve(null);
              }
            };
            img.onerror = () => resolve(null);
            img.src = p.cover_url;
          } catch (_) {
            resolve(null);
          }
        });
      }
      return artCache[p.id];
    }

    async function setTrack(p) {
      if (!ok || !global.MediaMetadata) return;
      const apply = (artwork) => {
        try {
          global.navigator.mediaSession.metadata = new global.MediaMetadata({
            title: p.title,
            artist: p.artist,
            album: p.album,
            artwork: artwork
          });
        } catch (_) {
          /* unsupported artwork type */
        }
      };
      apply([]);
      const png = await coverPng(p);
      if (currentId() === p.id) {
        apply(png ? [{ src: png, sizes: '512x512', type: 'image/png' }] : [{ src: p.cover_url, sizes: '512x512', type: 'image/svg+xml' }]);
      }
    }

    function setState(s) {
      if (!ok) return;
      try {
        global.navigator.mediaSession.playbackState = s;
      } catch (_) {
        /* ignore */
      }
    }

    function setPosition(force) {
      if (!ok || !global.navigator.mediaSession.setPositionState) return;
      const now = Date.now();
      if (!force && now - lastPosition < 1000) return;
      lastPosition = now;
      const dur = getDuration();
      if (!(dur > 0) || !isFinite(dur)) return;
      try {
        global.navigator.mediaSession.setPositionState({
          duration: dur,
          playbackRate: audio.playbackRate || 1,
          position: Math.max(0, Math.min(audio.currentTime || 0, dur))
        });
      } catch (_) {
        /* ignore invalid states */
      }
    }

    function init(handlers) {
      if (!ok) return;
      Object.keys(handlers).forEach((action) => {
        try {
          global.navigator.mediaSession.setActionHandler(action, handlers[action]);
        } catch (_) {
          /* action not supported in this browser */
        }
      });
    }

    return { ok: ok, setTrack: setTrack, setState: setState, setPosition: setPosition, init: init };
  })();

  function initMediaSession() {
    MS.init({
      play: () => resume(),
      pause: () => audio.pause(),
      previoustrack: () => prev(),
      nexttrack: () => next(),
      stop: () => {
        audio.pause();
        if (player.loaded) audio.currentTime = 0;
      },
      seekto: (d) => {
        if (!player.loaded || !d || typeof d.seekTime !== 'number') return;
        if (d.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(d.seekTime);
        else audio.currentTime = d.seekTime;
        updateTimeUI();
        MS.setPosition(true);
      },
      seekbackward: (d) => seekBy(-((d && d.seekOffset) || 10)),
      seekforward: (d) => seekBy((d && d.seekOffset) || 10)
    });
  }

  function seekBy(delta) {
    if (!player.loaded) return;
    const dur = getDuration();
    audio.currentTime = Math.max(0, Math.min(dur || Infinity, audio.currentTime + delta));
    updateTimeUI();
    MS.setPosition(true);
  }

  // ---------------------------- Track loading --------------------------------

  function unloadCurrent() {
    player.token += 1;
    player.loaded = false;
    try {
      audio.pause();
    } catch (_) {
      /* ignore */
    }
    audio.removeAttribute('src');
    try {
      audio.load();
    } catch (_) {
      /* ignore */
    }
    if (player.lease) {
      player.lease.revoke();
      player.lease = null;
    }
    player.status = player.queue.length ? 'paused' : 'idle';
  }

  async function loadTrack(index, autoplay) {
    if (index < 0 || index >= player.queue.length) return;
    const token = ++player.token;
    const productId = player.queue[index];
    const userId = state.user.id;

    player.index = index;
    player.loaded = false;
    try {
      audio.pause();
    } catch (_) {
      /* ignore */
    }
    player.status = 'loading';
    player.loadingText = 'Preparing...';
    writePrefs();
    render();

    try {
      const availability = await media.getAvailability({ userId: userId, productId: productId });
      if (token !== player.token) return;
      if (availability.state === 'owned_not_cached') {
        await media.cacheProduct({
          userId: userId,
          productId: productId,
          onProgress: (stage, fraction) => {
            if (token !== player.token) return;
            player.loadingText = stageLabel(stage, fraction);
            $$('[data-role="subtitle"]').forEach((el) => {
              el.textContent = player.loadingText;
            });
          }
        });
        if (token !== player.token) return;
      }

      // Throws NOT_LICENSED when the license is missing/revoked; autoCache repairs a damaged vault copy once.
      const lease = await media.openForPlayback({ userId: userId, productId: productId, autoCache: true });
      if (token !== player.token) {
        lease.revoke();
        return;
      }

      const old = player.lease;
      player.lease = lease;
      audio.src = lease.url;
      audio.loop = player.loop === 'one';
      if (old) old.revoke();
      player.loaded = true;
      player.status = 'paused';

      const product = state.byId[productId];
      if (product) {
        document.title = product.title + ' - ' + product.artist;
        MS.setTrack(product);
      }
      render();

      if (autoplay) {
        try {
          await audio.play();
        } catch (playError) {
          if (token !== player.token) return;
          player.status = 'paused';
          if (playError && playError.name === 'NotAllowedError') toast('Tap play to start.');
          else if (!playError || playError.name !== 'AbortError') toast('Could not start playback.', 'error');
          sync();
        }
      }
      sync();
    } catch (err) {
      if (token !== player.token) return;
      player.loaded = false;
      if (err && err.code === 'NOT_LICENSED') {
        const title = state.byId[productId] ? state.byId[productId].title : 'This item';
        toast(title + ' is no longer licensed and was skipped.', 'error');
        player.queue.splice(index, 1);
        scheduleRefresh();
        if (player.queue.length) {
          loadTrack(Math.min(index, player.queue.length - 1), autoplay);
        } else {
          player.index = -1;
          player.status = 'idle';
          writePrefs();
          render();
        }
        return;
      }
      player.status = 'paused';
      toast(friendlyError(err), 'error');
      render();
    }
  }

  function playQueue(ids, start) {
    if (!ids.length) return undefined;
    player.queue = ids.slice();
    writePrefs();
    return loadTrack(start, true);
  }

  function playProduct(id) {
    if (currentId() === id && player.loaded) return togglePlay();
    const ids = state.library.map((i) => i.license.product_id);
    const at = ids.indexOf(id);
    return at === -1 ? playQueue([id], 0) : playQueue(ids, at);
  }

  function playAll() {
    const ids = state.library.map((i) => i.license.product_id);
    if (!ids.length) {
      toast('Your library is empty.');
      return undefined;
    }
    return playQueue(ids, 0);
  }

  function enqueue(id) {
    if (!state.owned.has(id)) {
      toast('You need to own this first.');
      return;
    }
    if (player.queue.indexOf(id) !== -1) {
      toast('Already in the queue.');
      return;
    }
    player.queue.push(id);
    if (player.index === -1) {
      player.index = 0;
      player.status = 'paused';
    }
    writePrefs();
    toast('Added to queue.');
    render();
  }

  function removeFromQueue(i) {
    if (i < 0 || i >= player.queue.length) return;
    const wasCurrent = i === player.index;
    const wasPlaying = player.status === 'playing' || player.status === 'loading';
    player.queue.splice(i, 1);
    if (i < player.index) player.index -= 1;
    if (!player.queue.length) {
      unloadCurrent();
      player.index = -1;
      player.status = 'idle';
    } else if (wasCurrent) {
      if (player.index >= player.queue.length) player.index = player.queue.length - 1;
      unloadCurrent();
      writePrefs();
      loadTrack(player.index, wasPlaying);
      return;
    }
    writePrefs();
    render();
    sync();
  }

  function clearQueue() {
    unloadCurrent();
    player.queue = [];
    player.index = -1;
    player.status = 'idle';
    writePrefs();
    render();
    sync();
  }

  async function resume() {
    if (!player.queue.length) return;
    if (!player.loaded) {
      await loadTrack(player.index < 0 ? 0 : player.index, true);
      return;
    }
    try {
      await audio.play();
    } catch (e) {
      if (e && e.name === 'NotAllowedError') toast('Tap play to start.');
    }
  }

  function togglePlay() {
    if (!player.queue.length) return undefined;
    if (player.status === 'loading') return undefined;
    if (player.loaded && !audio.paused) {
      audio.pause();
      return undefined;
    }
    return resume();
  }

  function next() {
    const n = player.queue.length;
    if (!n) return;
    let i = player.index + 1;
    if (i >= n) {
      if (player.loop === 'all') i = 0;
      else return;
    }
    if (i === player.index && player.loaded) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    loadTrack(i, true);
  }

  function prev() {
    const n = player.queue.length;
    if (!n) return;
    if (player.loaded && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    let i = player.index - 1;
    if (i < 0) {
      if (player.loop === 'all') i = n - 1;
      else {
        if (player.loaded) audio.currentTime = 0;
        return;
      }
    }
    loadTrack(i, true);
  }

  function cycleLoop() {
    player.loop = player.loop === 'off' ? 'all' : player.loop === 'all' ? 'one' : 'off';
    audio.loop = player.loop === 'one';
    writePrefs();
    syncPlayerUI();
  }

  function setVolume(v) {
    audio.volume = Math.max(0, Math.min(1, v));
    audio.muted = false;
    writePrefs();
    syncPlayerUI();
  }

  function toggleMute() {
    audio.muted = !audio.muted;
    syncPlayerUI();
  }

  function onEnded() {
    if (!player.loaded) return;
    if (player.index < player.queue.length - 1) {
      next();
      return;
    }
    if (player.loop === 'all') {
      if (player.queue.length === 1) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      } else {
        loadTrack(0, true);
      }
      return;
    }
    audio.currentTime = 0;
    player.status = 'paused';
    sync();
  }

  audio.addEventListener('play', () => {
    if (!player.loaded) return;
    player.status = 'playing';
    sync();
  });
  audio.addEventListener('pause', () => {
    if (!player.loaded || audio.ended) return;
    player.status = 'paused';
    sync();
  });
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('timeupdate', () => {
    if (!player.loaded) return;
    updateTimeUI();
    MS.setPosition(false);
  });
  audio.addEventListener('durationchange', () => {
    updateTimeUI();
    MS.setPosition(true);
  });
  audio.addEventListener('volumechange', () => syncPlayerUI());
  audio.addEventListener('error', () => {
    if (!player.loaded) return;
    player.status = 'paused';
    toast('This file could not be played.', 'error');
    sync();
  });

  // Some mobile browsers only allow audio after a user gesture on the SAME element,
  // and our decrypt step runs asynchronously. Unlock the element on the first tap.
  let primed = false;

  function silentWav() {
    const n = 2;
    const bytes = new Uint8Array(44 + n * 2);
    const view = new DataView(bytes.buffer);
    const text = (o, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, n * 2, true);
    let bin = '';
    bytes.forEach((b) => {
      bin += String.fromCharCode(b);
    });
    return 'data:audio/wav;base64,' + global.btoa(bin);
  }

  function primeAudio() {
    if (primed) return;
    primed = true;
    if (player.loaded || player.status === 'loading') return;
    try {
      audio.src = silentWav();
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (_) {
      /* best effort */
    }
  }

  // ===========================================================================
  // 7. Library actions
  // ===========================================================================

  function updateChip(id) {
    $$('[data-chip="' + id + '"]').forEach((el) => {
      el.textContent = state.busy[id] || '';
      el.className = 'chip bg-violet-500/20 text-violet-200';
    });
  }

  async function downloadProduct(id) {
    if (state.busy[id]) return;
    state.busy[id] = 'Starting...';
    updateChip(id);
    try {
      await media.cacheProduct({
        userId: state.user.id,
        productId: id,
        onProgress: (stage, fraction) => {
          state.busy[id] = stageLabel(stage, fraction);
          updateChip(id);
        }
      });
      toast('Saved to your vault.');
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      delete state.busy[id];
      scheduleRefresh();
    }
  }

  async function evictProduct(id) {
    const p = state.byId[id];
    const ok = global.confirm(
      'Remove the downloaded copy of "' + (p ? p.title : 'this track') + '"? You keep your license and can download it again.'
    );
    if (!ok) return;
    await media.evict(id);
    toast('Removed from this device.');
  }

  // ===========================================================================
  // 8. Routing, events, boot
  // ===========================================================================

  function navigate(tab) {
    if (!VIEWS[tab]) return;
    if (tab === 'now' && state.tab !== 'now') state.prevTab = state.tab;
    const hash = '#/' + tab;
    if (global.location.hash !== hash) global.location.hash = hash;
    else applyRoute();
  }

  function applyRoute() {
    const match = /^#\/(\w+)/.exec(global.location.hash || '');
    const tab = match && VIEWS[match[1]] ? match[1] : 'shop';
    if (tab === 'now' && state.tab !== 'now') state.prevTab = state.tab;
    state.tab = tab;
    render();
  }

  const ACTIONS = {
    nav: (el) => navigate(el.dataset.tab),
    buy: (el) => startPurchase(el.dataset.id),
    'buy-confirm': () => confirmPurchase(),
    'play-product': (el) => playProduct(el.dataset.id),
    'play-all': () => playAll(),
    download: (el) => downloadProduct(el.dataset.id),
    evict: (el) => evictProduct(el.dataset.id),
    enqueue: (el) => enqueue(el.dataset.id),
    'open-redeem': (el) => openRedeemModal(el.dataset.mode, el.dataset.code),
    'rd-mode': (el) => setRedeemMode(el.dataset.mode),
    'rd-submit': () => submitTypedCode(),
    'rd-rescan': () => {
      setResult('');
      startScanner();
    },
    'close-modal': () => closeModal(),
    'acq-play': () => {
      const product = acq && acq.product;
      closeModal();
      if (product) return playProduct(product.id);
      return undefined;
    },
    'acq-retry': () => (acq && acq.retry ? acq.retry() : undefined),
    'toggle-play': () => togglePlay(),
    next: () => next(),
    prev: () => prev(),
    loop: () => cycleLoop(),
    mute: () => toggleMute(),
    'queue-jump': (el) => loadTrack(Number(el.dataset.index), true),
    'queue-remove': (el) => removeFromQueue(Number(el.dataset.index)),
    'queue-clear': () => clearQueue(),
    'mini-open': () => navigate('now'),
    'np-back': () => navigate(state.prevTab && state.prevTab !== 'now' ? state.prevTab : 'library'),
    reload: () => global.location.reload()
  };

  function bindEvents() {
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.id === 'modal-backdrop') {
        closeModal();
        return;
      }
      const el = target && target.closest ? target.closest('[data-action]') : null;
      if (!el) return;
      const handler = ACTIONS[el.dataset.action];
      if (!handler) return;
      Promise.resolve()
        .then(() => handler(el))
        .catch((err) => {
          console.error('[app] action failed', err);
          toast(friendlyError(err), 'error');
        });
    });

    document.addEventListener('input', (e) => {
      const t = e.target;
      if (!t) return;
      if (t.id === 'np-seek') {
        const frac = Number(t.value) / 1000;
        t.style.setProperty('--p', frac * 100 + '%');
        const c = $('#np-cur');
        if (c) c.textContent = fmtTime(frac * getDuration());
      } else if (t.id === 'np-vol') {
        t.style.setProperty('--p', t.value + '%');
        setVolume(Number(t.value) / 100);
      }
    });

    document.addEventListener('change', (e) => {
      const t = e.target;
      if (!t) return;
      if (t.id === 'np-seek') {
        const dur = getDuration();
        if (player.loaded && dur) {
          audio.currentTime = (Number(t.value) / 1000) * dur;
          MS.setPosition(true);
        }
        scrubbing = false;
      } else if (t.id === 'rd-file') {
        const file = t.files && t.files[0];
        t.value = '';
        if (file) scanPhoto(file);
      }
    });

    document.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.id === 'np-seek') scrubbing = true;
    });
    ['pointerup', 'pointercancel'].forEach((name) => {
      global.addEventListener(name, () => {
        scrubbing = false;
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
      else if (e.key === 'Enter' && e.target && e.target.id === 'rd-input') {
        e.preventDefault();
        submitTypedCode();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) Scanner.stop();
    });

    document.addEventListener('click', primeAudio, { capture: true, once: true });
    global.addEventListener('hashchange', applyRoute);

    ownership.on('license-granted', scheduleRefresh);
    ownership.on('license-revoked', (payload) => {
      const id = payload && payload.license && payload.license.product_id;
      if (id && currentId() === id) {
        unloadCurrent();
        toast('This license was revoked. Playback stopped.', 'error');
      }
      if (id) {
        const at = player.queue.indexOf(id);
        if (at !== -1) player.queue.splice(at, 1);
        if (!player.queue.length) {
          player.index = -1;
          player.status = 'idle';
        } else if (player.index >= player.queue.length) {
          player.index = player.queue.length - 1;
        }
        writePrefs();
      }
      scheduleRefresh();
    });
    media.on('cached', scheduleRefresh);
    media.on('evicted', scheduleRefresh);
  }

  async function scanPhoto(file) {
    setResult('');
    try {
      const text = await Scanner.scanImage(file);
      const code = text ? ownership.parseScannedPayload(text) : null;
      if (!code) {
        setResult(text ? "That QR code isn't an activation code." : 'No QR code found in that photo.', 'error');
        return;
      }
      Scanner.stop();
      await redeemFlow(code);
    } catch (e) {
      setResult(scanErrorMessage(e), 'error');
    }
  }

  function fatal(error) {
    console.error('[app] fatal', error);
    const view = $('#view');
    if (view) {
      view.innerHTML =
        '<div style="padding:24px"><h2 style="font-size:20px;font-weight:700">Couldn\'t start</h2>' +
        '<p style="margin-top:8px;color:#a3a3a3">' + esc(friendlyError(error)) + '</p>' +
        '<p style="margin-top:8px;color:#737373;font-size:13px">Private browsing modes can block local storage. Try a normal window.</p>' +
        '<button class="btn btn-primary" style="margin-top:16px" data-action="reload">Reload</button></div>';
    }
    document.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-action="reload"]')) global.location.reload();
    });
  }

  function checkStyles() {
    if (global.tailwind) return;
    const banner = $('#banner');
    if (banner) {
      banner.innerHTML =
        '<div style="background:#78350f;color:#fde68a;padding:8px 16px;font-size:13px">Styles could not load from the Tailwind CDN. Connect to the internet once and reload for the full look. Your library still works.</div>';
    }
  }

  async function boot() {
    checkStyles();
    try {
      await db.init();
      state.user = await db.getCurrentUser();
      if (!state.user) throw new Error('No local profile was found.');
      bindEvents();
      initMediaSession();
      await refreshData();
      restorePrefs();
      applyRoute();
    } catch (e) {
      fatal(e);
    }
  }

  boot();

  // Small surface for debugging from the console.
  global.OwnApp = Object.freeze({ state: state, player: player, navigate: navigate, playProduct: playProduct, refresh: refreshData });
})(typeof window !== 'undefined' ? window : globalThis);
