'use strict';

// Cross-browser namespace: Firefox exposes `browser` (promises), Chrome/Edge
// expose `chrome` (MV3 APIs also return promises when no callback is passed).
const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  serverBase: 'http://127.0.0.1:4123',
  format: 'webp', // 'webp' | 'png'
  quality: 0.85, // lossy quality for webp/jpeg
  maxEdge: 1568, // downscale the longest edge to this many px (0 = no downscale)
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
  try {
    const stored = await api.storage?.local.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
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

async function encode(bitmap, cfg) {
  let { width, height } = bitmap;
  if (cfg.maxEdge > 0) {
    const longest = Math.max(width, height);
    if (longest > cfg.maxEdge) {
      const scale = cfg.maxEdge / longest;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);

  // Try the requested format; fall back to PNG if the browser cannot encode it
  // (notably WebP encoding on some Firefox versions).
  let mimeType = cfg.format === 'png' ? 'image/png' : 'image/webp';
  let blob = await canvas.convertToBlob({ type: mimeType, quality: cfg.quality });
  if (blob.type !== mimeType) {
    mimeType = 'image/png';
    blob = await canvas.convertToBlob({ type: 'image/png' });
  }
  return { blob, mimeType };
}

// Crop a bitmap to `crop` (image px), clamped to the bitmap's real size so a
// stray devicePixelRatio or off-by-one can never read outside the source.
async function cropBitmap(bitmap, crop) {
  const sx = Math.max(0, Math.min(crop.x, bitmap.width));
  const sy = Math.max(0, Math.min(crop.y, bitmap.height));
  const sw = Math.max(1, Math.min(crop.w, bitmap.width - sx));
  const sh = Math.max(1, Math.min(crop.h, bitmap.height - sy));
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const cropped = await createImageBitmap(canvas);
  bitmap.close?.();
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
      title: 'snapstack',
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

// Sync once when the worker/event page spins up.
syncBadge();
