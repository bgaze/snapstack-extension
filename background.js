'use strict';

// Cross-browser namespace: Firefox exposes `browser` (promises), Chrome/Edge
// expose `chrome` (MV3 APIs also return promises when no callback is passed).
const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  serverBase: 'http://127.0.0.1:4123',
  format: 'webp', // 'webp' | 'png' | 'jpg'
  quality: 0.85, // lossy quality for webp/jpeg, 0..1
  maxWidth: 1568, // downscale captures wider than this to this width in px (0 = no downscale)
  maxSlices: 50, // full-page capture: safety net against endless/infinite-scroll pages
};

const COLOR_IDLE = '#4F46E5';
const COLOR_OK = '#16A34A';
const COLOR_ERR = '#DC2626';
const COLOR_WARN = '#D97706'; // amber: server reachable but its protocol is behind us

// Wire protocol this extension speaks; the server advertises its own on /health.
// If the server's protocol is older — or absent, i.e. a pre-handshake server — it
// can't be trusted to understand what we send, so we nudge the user to update it
// (the server and the extension update on different channels, so they can drift).
// Bump in lock-step with the server's PROTOCOL_VERSION on a breaking /push change.
const CLIENT_PROTOCOL = 1;

// Where the "update it" nudge points: the server README's install/update section.
const UPDATE_URL = 'https://github.com/bgaze/snapstack-server#install--run';
const OUTDATED_NOTIF_ID = 'snapstack-server-outdated';

async function getConfig() {
  let cfg;
  try {
    const stored = await api.storage?.local.get(DEFAULTS);
    cfg = { ...DEFAULTS, ...stored };
  } catch {
    cfg = { ...DEFAULTS };
  }
  // The capture policy (format/quality/maxWidth/maxSlices) is owned by the server
  // so a single edit applies to every browser the user runs; serverBase stays
  // local. Overlay the server's effective policy. Fall back to DEFAULTS if the
  // server is unreachable or predates /config (404) — capture must never break,
  // and DEFAULTS mirror the server's DEFAULT_POLICY so the fallback is identical.
  try {
    const r = await fetch(`${cfg.serverBase}/config`);
    if (r.ok) cfg = { ...cfg, ...(await r.json()) };
  } catch {
    /* offline / pre-/config server → keep the local DEFAULTS */
  }
  return cfg;
}

// --- badge ----------------------------------------------------------------
async function setBadge(text, color) {
  try {
    await api.action.setBadgeText({ text });
    if (color) await api.action.setBadgeBackgroundColor({ color });
  } catch {
    /* action API unavailable mid-teardown */
  }
}

async function refreshBadge(cfg) {
  try {
    const r = await fetch(`${cfg.serverBase}/count`);
    const { count } = await r.json();
    await setBadge(count > 0 ? String(count) : '', COLOR_IDLE);
  } catch {
    await setBadge('!', COLOR_ERR); // server unreachable
  }
}

// Compare the server's advertised wire protocol against ours. Returns
// 'unreachable' | 'outdated' | 'ok', and persists the verdict (so the popup can
// surface it) plus fires a one-shot notification on the transition to outdated.
async function checkCompat(cfg) {
  let health;
  try {
    const r = await fetch(`${cfg.serverBase}/health`);
    if (!r.ok) throw new Error(String(r.status));
    health = await r.json();
  } catch {
    return 'unreachable';
  }
  // A server with no `protocol` predates the handshake → it is behind this extension.
  const ok = typeof health.protocol === 'number' && health.protocol >= CLIENT_PROTOCOL;
  await setCompat(ok ? null : 'outdated');
  return ok ? 'ok' : 'outdated';
}

// Persist the compatibility verdict (null = compatible) and notify once per
// transition — not on every 1-minute sync.
async function setCompat(reason) {
  let prev = null;
  try {
    ({ serverCompat: prev = null } = await api.storage.local.get('serverCompat'));
  } catch {
    /* storage unavailable */
  }
  if ((reason ?? null) === (prev ?? null)) return; // no transition
  try {
    await api.storage.local.set({ serverCompat: reason });
  } catch {
    /* storage unavailable */
  }
  if (reason === 'outdated') {
    const text = `${api.i18n.getMessage('serverOutdated')} ${api.i18n.getMessage('serverOutdatedAction')}`;
    await showNotification(text, OUTDATED_NOTIF_ID); // click opens UPDATE_URL (see onClicked below)
  }
}

// Reflect server state on the badge: an out-of-date server gets a distinct amber
// warning (capture is never blocked — we still try /push), unreachable gets the
// red error mark, otherwise the pending count.
async function syncBadge() {
  const cfg = await getConfig();
  const compat = await checkCompat(cfg);
  if (compat === 'unreachable') return setBadge('!', COLOR_ERR);
  if (compat === 'outdated') return setBadge('⚠', COLOR_WARN);
  return refreshBadge(cfg);
}

// --- capture pipeline -----------------------------------------------------
async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// Re-encode `bitmap` to the configured format. `downscale` picks the resize rule:
//   'width' — cap the WIDTH to cfg.maxWidth (the viewport/zone capture), keeping
//             aspect ratio; a tall, narrow shot keeps its full height. Consistent
//             with the full-page stitch, which also caps width (not the longest edge).
//   'skip'  — no resize (the full-page stitch has already sized the canvas).
async function encode(bitmap, cfg, downscale = 'width') {
  let { width, height } = bitmap;
  if (downscale === 'width' && cfg.maxWidth > 0 && width > cfg.maxWidth) {
    const scale = cfg.maxWidth / width;
    width = cfg.maxWidth;
    height = Math.round(height * scale);
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);

  // Try the requested format; fall back to PNG if the browser cannot encode it
  // (notably WebP encoding on some Firefox versions).
  const MIME_BY_FORMAT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  let mimeType = MIME_BY_FORMAT[cfg.format] ?? 'image/webp';
  let blob = await canvas.convertToBlob({ type: mimeType, quality: cfg.quality });
  if (blob.type !== mimeType) {
    mimeType = 'image/png';
    blob = await canvas.convertToBlob({ type: 'image/png' });
  }
  return { blob, mimeType };
}

// Crop a bitmap to `crop` (image px), clamped to the bitmap's real size so a
// stray devicePixelRatio or off-by-one can never read outside the source.
// `closeSource` defaults to true; pass false when one shot feeds several crops
// (multi-pane), so the shared source isn't detached after the first column.
async function cropBitmap(bitmap, crop, closeSource = true) {
  const sx = Math.max(0, Math.min(crop.x, bitmap.width));
  const sy = Math.max(0, Math.min(crop.y, bitmap.height));
  const sw = Math.max(1, Math.min(crop.w, bitmap.width - sx));
  const sh = Math.max(1, Math.min(crop.h, bitmap.height - sy));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const cropped = await createImageBitmap(canvas);
  if (closeSource) bitmap.close?.();
  return cropped;
}

// `crop` (image px) is optional: omitted → full visible tab; provided → the
// captured frame is cropped to it before the usual encode/downscale/push.
async function capture(crop) {
  const cfg = await getConfig();

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');

  const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  let bitmap = await dataUrlToBitmap(dataUrl);
  if (crop) bitmap = await cropBitmap(bitmap, crop);
  const { blob, mimeType } = await encode(bitmap, cfg);
  bitmap.close?.();

  const body = await blob.arrayBuffer();
  const resp = await fetch(`${cfg.serverBase}/push`, {
    method: 'POST',
    headers: {
      'Content-Type': mimeType,
      'X-Snapstack-Url': encodeURIComponent(tab.url ?? ''),
      'X-Snapstack-Title': encodeURIComponent(tab.title ?? ''),
    },
    body,
  });
  if (!resp.ok) throw new Error(`server responded ${resp.status}`);
  const { count } = await resp.json();
  return count;
}

// --- feedback -------------------------------------------------------------
function flashOk(count) {
  setBadge('✓', COLOR_OK);
  setTimeout(() => setBadge(count > 0 ? String(count) : '', COLOR_IDLE), 600);
}

async function showNotification(message, id) {
  try {
    const opts = {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon-128.png'),
      title: 'SnapStack',
      message,
    };
    // A stable id lets onClicked recognise this notification (and replaces any
    // previous one of the same id instead of stacking duplicates).
    if (id) await api.notifications.create(id, opts);
    else await api.notifications.create(opts);
  } catch {
    /* notifications unavailable */
  }
}

async function notifyError(err) {
  const raw = String(err?.message || err);
  const unreachable = /Failed to fetch|NetworkError|ECONNREFUSED/i.test(raw);
  const message = unreachable
    ? api.i18n.getMessage('serverNotRunning')
    : api.i18n.getMessage('captureFailed', [raw]);
  await showNotification(message);
  await setBadge('!', COLOR_ERR);
}

async function onTrigger() {
  try {
    const count = await capture();
    flashOk(count);
    return { ok: true, count };
  } catch (e) {
    await notifyError(e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- area-selection capture -----------------------------------------------
// The popup is torn down the moment focus leaves it for the page, so the whole
// zone flow lives here: inject the overlay, wait for the user to draw a
// rectangle (or cancel), then crop the visible-tab capture to it.
const ZONE_UNAVAILABLE = '__zone_unavailable__';

// Resolve with the 'zone-selected' message, or null if the user cancelled.
function waitForZone() {
  return new Promise((resolve) => {
    const onMsg = (msg) => {
      if (msg?.type !== 'zone-selected' && msg?.type !== 'zone-cancelled') return;
      api.runtime.onMessage.removeListener(onMsg);
      resolve(msg.type === 'zone-selected' ? msg : null);
    };
    api.runtime.onMessage.addListener(onMsg);
  });
}

// Selection rectangle (CSS px + dpr) → crop rectangle in captured-image px.
// captureVisibleTab returns physical pixels (= CSS viewport × dpr); cropBitmap
// clamps the result against the real frame size.
function cropFromSelection(sel) {
  const { rect, dpr } = sel;
  return {
    x: Math.round(rect.x * dpr),
    y: Math.round(rect.y * dpr),
    w: Math.round(rect.w * dpr),
    h: Math.round(rect.h * dpr),
  };
}

async function captureZone() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
  } catch {
    // Browser-internal pages (chrome://, the web store, the PDF viewer, …) reject
    // injection — there is no page to draw on.
    throw new Error(ZONE_UNAVAILABLE);
  }
  const sel = await waitForZone();
  if (!sel) return null; // cancelled — no capture
  return capture(cropFromSelection(sel));
}

async function onTriggerZone() {
  try {
    const count = await captureZone();
    if (count == null) return { ok: true, cancelled: true };
    flashOk(count);
    return { ok: true, count };
  } catch (e) {
    if (String(e?.message) === ZONE_UNAVAILABLE) {
      await showNotification(api.i18n.getMessage('zoneUnavailable'));
      return { ok: false, error: 'zone_unavailable' };
    }
    await notifyError(e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- full-page capture ----------------------------------------------------
// captureVisibleTab only ever sees the visible viewport, so a full-page shot is
// built by scrolling the page one screen at a time, photographing each step, and
// stitching the slices onto one tall canvas. This is the only fully-local,
// no-extra-permission, cross-browser path (CDP/debugger would be Chrome-only,
// pop an alarming banner, and still not cover inner scroll containers).
//
// The intelligence is in WHAT we scroll. fpPrep detects the dominant scroller and
// picks one of two modes:
//   • 'root' — the window scrolls (articles, search results). Fixed/sticky
//     elements are frozen (so a sticky header is shot once), and we stitch the
//     full viewport at each scroll offset.
//   • 'pane' — an inner overflow container is the main scroller (app shells:
//     fixed header + sidebar + scrollable content). The first slice is the FULL
//     viewport (so the chrome — header/sidebar — is captured once); later slices
//     are just the pane, stacked below in its column. Undrawn margins are filled
//     with the page background. Only sticky elements INSIDE the pane are frozen.
//
// Multiple scrollers: 'pane' mode detects a set of disjoint vertical scrollers
// (an app shell's content + a scrollable sidebar, a board's columns) and unrolls
// EACH in its own column — they are scrolled in lockstep, one viewport snapshot
// per step, each clipped to its rect. Horizontal overflow is ignored (only the
// columns visible in the viewport are captured). Nested scrollers: only the
// outermost is unrolled; a window-scrolled page uses 'root' mode instead.
//
// Robust freeze: a stylesheet rule keyed on a marker attribute (with !important)
// + a re-scan before every slice, so a header the page re-pins in JS mid-scroll
// is still neutralized. Page-side steps run as separate scripting.executeScript
// calls and share state through the DOM (a <style> node + marker attributes),
// the same trick overlay.js uses — no long-lived content script.
//
// Anti-infinite-scroll: the target height is snapshotted ONCE in fpPrep, so
// content that lazy-loads while we scroll is never chased; we also stop as soon
// as scrolling stops advancing, and hard-cap the slice count.
const FULL_UNAVAILABLE = '__full_unavailable__';
const SLICE_DELAY_MS = 550; // throttle: stay under Chrome's ~2 captureVisibleTab/s
const SETTLE_MS = 150; // let the page settle (sticky reflow, lazy content) after each scroll
const FREEZE_PAINT_MS = 50; // let a freshly-hidden header repaint before the snapshot
const MAX_CANVAS_PX = 16384; // conservative per-edge canvas cap (Chrome/Firefox)
const PANE_MIN_VH_RATIO = 0.25; // a scroller must be at least this tall (share of viewport height)
const PANE_MIN_AREA_RATIO = 0.06; // ...and cover at least this share of the viewport area
const FULLPAGE_STYLE_ID = 'snapstack-fullpage';
const FULLPAGE_POS_ATTR = 'data-snapstack-pos';
const FULLPAGE_SCROLLER_ATTR = 'data-snapstack-scroller';
const FULLPAGE_TOP_ATTR = 'data-snapstack-scrolltop';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- page-side helpers (serialized and injected, run in the page) ---
// Self-contained: they read only their args + DOM globals, never this module.

// Detect the vertical scroll container(s) and prep the page. Also probes
// injectability (browser-internal pages reject the injection). Vertical scroll
// only; horizontal overflow is ignored.
//
// Returns { mode, view:{w,h}, bg, dpr, origin } plus, by mode:
//   'pane' → panes: [{ scrollH, clip:{x,y,w,h} }]  (one per detected scroller)
//   'root' → scrollH, clip:{x,y,w,h}               (the window / full viewport)
function fpPrep(styleId, posAttr, scrollerAttr, topAttr, minVh, minArea) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const origin = { x: window.scrollX, y: window.scrollY };
  const view = { w: vw, h: vh };

  // One stylesheet: kill smooth scrolling, and HIDE any element we later mark
  // with posAttr. Hiding (not re-positioning) is robust against a page that
  // re-pins its header in JS mid-scroll, and the attribute + !important beats the
  // page's own inline styles. Marking happens from the 2nd slice onward (see
  // fpFreeze) so the first slice still shows the chrome once, at the top.
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent =
    '*{scroll-behavior:auto !important}' + '[' + posAttr + ']{visibility:hidden !important}';
  document.documentElement.appendChild(style);

  // Background painted behind the composite (margins no slice covers, e.g. under
  // a sidebar once its content is shorter than the tallest column).
  let bg = '';
  try {
    bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
  } catch {
    /* ignore */
  }
  if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') bg = '#ffffff';

  // Collect every element that actually scrolls vertically and is big enough to
  // be a real content region (not a tiny widget). Sort by visible area, desc.
  const candidates = [];
  for (const el of document.querySelectorAll('*')) {
    if (el === document.documentElement || el === document.body) continue;
    if (el.scrollHeight - el.clientHeight < 4) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    const r = el.getBoundingClientRect();
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (visH < vh * minVh || visW * visH < vw * vh * minArea) continue;
    candidates.push({ el, area: visW * visH, r });
  }
  candidates.sort((a, b) => b.area - a.area);

  // Keep a disjoint set: drop any scroller nested inside (or containing) one we
  // already kept, so the columns never overlap (largest wins → outermost).
  const chosen = [];
  for (const c of candidates) {
    if (chosen.some((k) => k.el.contains(c.el) || c.el.contains(k.el))) continue;
    chosen.push(c);
  }

  // PANE: one or more inner scrollers. Tag each (so a later step can re-find and
  // scroll it), stash its scrollTop, and report its on-screen clip + content height.
  if (chosen.length) {
    const panes = chosen.map((c, i) => {
      c.el.setAttribute(scrollerAttr, String(i));
      c.el.setAttribute(topAttr, String(c.el.scrollTop));
      const x = Math.max(0, c.r.left);
      const y = Math.max(0, c.r.top);
      return {
        scrollH: c.el.scrollHeight,
        clip: { x, y, w: Math.min(c.r.width, vw - x), h: Math.min(c.r.height, vh - y) },
      };
    });
    return { mode: 'pane', panes, view, bg, dpr, origin };
  }

  // ROOT: the window scrolls. Fixed/sticky elements are hidden from the 2nd
  // slice onward (fpFreeze) so a sticky header is photographed once, at the top.
  const root = document.documentElement;
  const bodyH = document.body ? document.body.scrollHeight : 0;
  return {
    mode: 'root',
    scrollH: Math.max(root.scrollHeight, bodyH, vh),
    clip: { x: 0, y: 0, w: vw, h: vh },
    view,
    bg,
    dpr,
    origin,
  };
}

// Re-mark fixed/sticky elements the page may have pinned in JS during our scroll.
// Scoped to the detected panes in pane mode (chrome stays as captured), whole
// document in root mode.
function fpFreeze(posAttr, scrollerAttr) {
  const panes = document.querySelectorAll('[' + scrollerAttr + ']');
  const scopes = panes.length ? panes : [document.documentElement];
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll('*')) {
      if (el.hasAttribute(posAttr)) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') el.setAttribute(posAttr, '1');
    }
  }
}

// Scroll the window to y; report the real position reached (clamped at the
// bottom). Used in root mode.
function fpScrollWindow(y) {
  window.scrollTo(0, y);
  return window.scrollY;
}

// Scroll each tagged pane to its target (targets[i] = scrollTop for pane i),
// report the real positions reached. Panes move in lockstep, one snapshot/step.
function fpScrollPanes(targets, scrollerAttr) {
  const out = [];
  for (let i = 0; i < targets.length; i++) {
    const el = document.querySelector('[' + scrollerAttr + '="' + i + '"]');
    if (el) {
      el.scrollTop = targets[i];
      out.push(el.scrollTop);
    } else {
      out.push(0);
    }
  }
  return out;
}

// Undo fpPrep: drop the style, un-mark frozen elements, restore each pane's own
// scrollTop, and return the window to its origin scroll.
function fpRestore(styleId, posAttr, scrollerAttr, topAttr, origin) {
  const style = document.getElementById(styleId);
  if (style) style.remove();
  for (const el of document.querySelectorAll('[' + posAttr + ']')) el.removeAttribute(posAttr);
  for (const el of document.querySelectorAll('[' + scrollerAttr + ']')) {
    const top = el.getAttribute(topAttr);
    if (top != null) el.scrollTop = Number(top);
    el.removeAttribute(scrollerAttr);
    el.removeAttribute(topAttr);
  }
  window.scrollTo(origin.x, origin.y);
}

// captureVisibleTab is rate-limited (~2/s in Chrome). We already throttle
// between slices; if we still hit the quota, back off once and retry.
async function captureSlice(windowId) {
  try {
    return await dataUrlToBitmap(await api.tabs.captureVisibleTab(windowId, { format: 'png' }));
  } catch (e) {
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(String(e?.message || e))) throw e;
    await delay(SLICE_DELAY_MS);
    return dataUrlToBitmap(await api.tabs.captureVisibleTab(windowId, { format: 'png' }));
  }
}

async function captureFull() {
  const cfg = await getConfig();
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');

  const run = (func, args) => api.scripting.executeScript({ target: { tabId: tab.id }, func, args });

  // Detect the scroller + prep the page. This is also the injectability probe
  // (browser-internal pages reject it → FULL_UNAVAILABLE).
  let info;
  try {
    [{ result: info }] = await run(fpPrep, [
      FULLPAGE_STYLE_ID,
      FULLPAGE_POS_ATTR,
      FULLPAGE_SCROLLER_ATTR,
      FULLPAGE_TOP_ATTR,
      PANE_MIN_VH_RATIO,
      PANE_MIN_AREA_RATIO,
    ]);
  } catch {
    throw new Error(FULL_UNAVAILABLE);
  }
  if (!info) throw new Error(FULL_UNAVAILABLE);

  const { mode, view, bg, dpr, origin } = info;
  const pane = mode === 'pane';

  // Normalize to a list of columns to unroll: root → one column scrolling the
  // window; pane → one column per detected scroller, placed at its own x. Each
  // column carries its content height and the chrome offset above it (clip.y).
  const columns = pane
    ? info.panes.map((p) => ({ clip: p.clip, scrollH: p.scrollH, contentTop: p.clip.y }))
    : [{ clip: info.clip, scrollH: info.scrollH, contentTop: 0 }];

  // Canvas: full viewport width (so the chrome/sidebar fits); height = the
  // tallest unrolled column (shorter columns are padded with the page bg).
  const physW = view.w * dpr;
  const fullCssH = Math.max(view.h, ...columns.map((c) => c.contentTop + c.scrollH));
  const physH = fullCssH * dpr;
  const widthCap = cfg.maxWidth > 0 ? cfg.maxWidth / physW : 1;
  const scale = Math.min(1, widthCap, MAX_CANVAS_PX / physW, MAX_CANVAS_PX / physH);
  const canvasW = Math.max(1, Math.round(physW * scale));
  const canvasH = Math.max(1, Math.round(physH * scale));
  const fullDh = Math.round(view.h * dpr * scale); // a whole-viewport slice

  const canvas = new OffscreenCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg || '#ffffff'; // margins no slice covers (e.g. under a sidebar)
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Per-column geometry (scaled physical px) + scroll bookkeeping.
  const cols = columns.map((c) => ({
    contentTop: c.contentTop,
    stepH: Math.max(1, Math.round(c.clip.h)),
    bottom: Math.max(0, c.scrollH - c.clip.h),
    cropPx: {
      x: Math.round(c.clip.x * dpr),
      y: Math.round(c.clip.y * dpr),
      w: Math.round(c.clip.w * dpr),
      h: Math.round(c.clip.h * dpr),
    },
    dx: Math.round(c.clip.x * dpr * scale),
    dw: Math.round(c.clip.w * dpr * scale),
    dh: Math.round(c.clip.h * dpr * scale),
    prevY: -1,
    done: false,
  }));

  // Walk down one capture window at a time (all columns in lockstep), up to the
  // heights snapshotted in fpPrep. Stop when no column can advance, or the slice
  // cap is hit — never chasing content that lazy-loads while we scroll.
  let truncated = false;
  try {
    for (let i = 0; ; i++) {
      let realYs;
      if (pane) {
        const targets = cols.map((c) => Math.min(i * c.stepH, c.bottom));
        [{ result: realYs }] = await run(fpScrollPanes, [targets, FULLPAGE_SCROLLER_ATTR]);
      } else {
        const [{ result: ry }] = await run(fpScrollWindow, [Math.min(i * cols[0].stepH, cols[0].bottom)]);
        realYs = [ry];
      }
      await delay(SETTLE_MS); // let scroll-driven JS run (re-pinning, lazy content)
      if (i > 0) {
        // Hide the chrome the page may have (re)pinned during the settle, so it
        // is captured only in the first slice. AFTER the settle, to win the race.
        await run(fpFreeze, [FULLPAGE_POS_ATTR, FULLPAGE_SCROLLER_ATTR]).catch(() => {});
        await delay(FREEZE_PAINT_MS);
      }
      const shot = await captureSlice(tab.windowId);

      if (pane && i === 0) {
        // First slice: the whole viewport → chrome (header/sidebar) + every
        // column's first screen, captured once.
        ctx.drawImage(shot, 0, 0, canvasW, fullDh);
      } else if (pane) {
        // Later slices: each still-advancing column, stacked in its own column.
        for (let c = 0; c < cols.length; c++) {
          if (cols[c].done) continue;
          const sliceImg = await cropBitmap(shot, cols[c].cropPx, false); // shared shot → don't detach it
          ctx.drawImage(
            sliceImg,
            cols[c].dx,
            Math.round((cols[c].contentTop + realYs[c]) * dpr * scale),
            cols[c].dw,
            cols[c].dh,
          );
          sliceImg.close?.();
        }
      } else {
        // Root mode: the whole viewport at its scroll offset.
        ctx.drawImage(shot, 0, Math.round(realYs[0] * dpr * scale), canvasW, fullDh);
      }
      shot.close?.();

      // Mark columns that reached the bottom (or stopped advancing); stop when
      // none can advance, or the slice cap is hit.
      let advancing = false;
      for (let c = 0; c < cols.length; c++) {
        const target = Math.min(i * cols[c].stepH, cols[c].bottom);
        if (target >= cols[c].bottom || realYs[c] <= cols[c].prevY) cols[c].done = true;
        else advancing = true;
        cols[c].prevY = realYs[c];
      }
      if (!advancing) break;
      if (i + 1 >= cfg.maxSlices) {
        truncated = true;
        break;
      }
      await delay(SLICE_DELAY_MS);
    }
  } finally {
    // Always restore, even if a slice threw mid-capture.
    await run(fpRestore, [
      FULLPAGE_STYLE_ID,
      FULLPAGE_POS_ATTR,
      FULLPAGE_SCROLLER_ATTR,
      FULLPAGE_TOP_ATTR,
      origin,
    ]).catch(() => {});
  }

  const stitched = await createImageBitmap(canvas);
  const { blob, mimeType } = await encode(stitched, cfg, 'skip'); // already sized
  stitched.close?.();

  const body = await blob.arrayBuffer();
  const resp = await fetch(`${cfg.serverBase}/push`, {
    method: 'POST',
    headers: {
      'Content-Type': mimeType,
      'X-Snapstack-Url': encodeURIComponent(tab.url ?? ''),
      'X-Snapstack-Title': encodeURIComponent(tab.title ?? ''),
    },
    body,
  });
  if (!resp.ok) throw new Error(`server responded ${resp.status}`);
  const { count } = await resp.json();
  // No silent caps: tell the user when a too-long page was only partially captured.
  if (truncated) await showNotification(api.i18n.getMessage('fullPageTruncated', [String(cfg.maxSlices)]));
  return count;
}

async function onTriggerFull() {
  try {
    const count = await captureFull();
    flashOk(count);
    return { ok: true, count };
  } catch (e) {
    if (String(e?.message) === FULL_UNAVAILABLE) {
      await showNotification(api.i18n.getMessage('fullPageUnavailable'));
      return { ok: false, error: 'full_unavailable' };
    }
    console.error('[snapstack] full-page capture failed:', e); // surface it in the worker console
    await notifyError(e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- server mutations (delegated by the popup) ----------------------------
// Run here, not in the popup: a native confirm() or a new tab closes the popup,
// and an in-flight fetch in a torn-down popup may be aborted. The worker is not
// tied to the popup lifecycle, so the operation always completes.
async function serverOp(method, path) {
  const cfg = await getConfig();
  try {
    const r = await fetch(`${cfg.serverBase}${path}`, { method });
    await refreshBadge(cfg);
    return { ok: r.ok };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- wiring (listeners registered synchronously at worker startup) --------
// The toolbar action opens the popup (default_popup), so there is no
// action.onClicked path. The popup drives capture and stack mutations by message.
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'capture':
      onTrigger().then(sendResponse);
      return true;
    case 'capture-zone':
      onTriggerZone().then(sendResponse);
      return true;
    case 'capture-full':
      onTriggerFull().then(sendResponse);
      return true;
    case 'clear':
      serverOp('POST', '/clear').then(sendResponse);
      return true;
    case 'delete':
      serverOp('DELETE', `/file/${encodeURIComponent(msg.name)}`).then(sendResponse);
      return true;
    case 'reveal':
      serverOp('POST', '/reveal').then(sendResponse);
      return true;
    default:
      return false;
  }
});

// The stack can be drained server-side by the MCP client (get/clear), and the
// server has no channel to push to the extension. Resync the badge on the
// moments the user is likely to look at it — switching tab, refocusing the
// browser — plus a periodic alarm as an idle self-heal.
api.tabs.onActivated.addListener(syncBadge);
api.windows?.onFocusChanged.addListener((windowId) => {
  if (windowId !== api.windows.WINDOW_ID_NONE) syncBadge();
});
api.alarms.create('snapstack-sync', { periodInMinutes: 1 });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'snapstack-sync') syncBadge();
});

// Clicking the "server out of date" notification opens the update guide.
api.notifications?.onClicked.addListener((id) => {
  if (id === OUTDATED_NOTIF_ID) api.tabs.create({ url: UPDATE_URL });
});

// Keyboard shortcuts (manifest `commands`): one per capture mode. Bindings are
// set/changed in the browser's own shortcuts UI (per-browser, local).
api.commands?.onCommand.addListener((command) => {
  if (command === 'capture') onTrigger();
  else if (command === 'capture-zone') onTriggerZone();
  else if (command === 'capture-full') onTriggerFull();
});

// Sync once when the worker/event page spins up.
syncBadge();
