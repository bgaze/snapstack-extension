'use strict';

// Cross-browser namespace, same convention as background.js.
const api = globalThis.browser ?? globalThis.chrome;

// Localized UI string — resolved from _locales by the browser's UI language,
// with English (default_locale) as the built-in fallback.
const t = (key, subs) => api.i18n?.getMessage(key, subs) || key;

const DEFAULTS = { serverBase: 'http://127.0.0.1:4123' };

// Server README install/update section — target of the version-skew nudge link.
const UPDATE_URL = 'https://github.com/bgaze/snapstack-server#install--run';

async function getConfig() {
  try {
    return { ...DEFAULTS, ...(await api.storage?.local.get(DEFAULTS)) };
  } catch {
    return { ...DEFAULTS };
  }
}

// --- icons (inline SVG, static — safe to inject as innerHTML) --------------
const ICONS = {
  trash:
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  folder:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  copy:
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  camera:
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  crop: '<path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"/><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"/>',
  // Full page: a page outline with a top-to-bottom double arrow.
  fullpage:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><polyline points="9 8 12 5 15 8"/><polyline points="9 16 12 19 15 16"/><line x1="12" y1="5" x2="12" y2="19"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  // Settings: cog + center hub (feather "settings").
  gear:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

// Build an SVG node from the static markup (DOMParser, not innerHTML, so the
// content is never treated as a dynamic/unsafe assignment).
function svgEl(name) {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
}

function iconButton(name, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon';
  b.dataset.tip = title; // CSS tooltip (immediate, stays inside the popup)
  b.setAttribute('aria-label', title);
  b.replaceChildren(svgEl(name));
  b.addEventListener('click', onClick);
  return b;
}

// Swap a button's icon to a green check for ~1s after a successful copy.
function flashCheck(btn, name) {
  btn.classList.add('ok');
  btn.replaceChildren(svgEl('check'));
  setTimeout(() => {
    btn.classList.remove('ok');
    btn.replaceChildren(svgEl(name));
  }, 1000);
}

function copyText(text, btn, iconName) {
  if (!text) return;
  navigator.clipboard
    .writeText(text)
    .then(() => flashCheck(btn, iconName))
    .catch(() => {});
}

// --- state & DOM -----------------------------------------------------------
const toolbarEl = document.getElementById('toolbar');
const scrollEl = document.getElementById('scroll');
const state = { items: [], base: DEFAULTS.serverBase };

// Stack-dependent toolbar buttons (disabled when the stack is empty).
const toolbarBtns = {};

// Enable "Delete all" / "Copy all paths" only when there is something to act on.
function setStackButtons(hasItems) {
  if (toolbarBtns.clear) toolbarBtns.clear.disabled = !hasItems;
  if (toolbarBtns.copyAll) toolbarBtns.copyAll.disabled = !hasItems;
}

// Map of command name → its current keyboard shortcut (empty if unbound), so the
// capture buttons can advertise their shortcut in the tooltip.
async function captureShortcuts() {
  const map = {};
  try {
    for (const c of await api.commands.getAll()) {
      if (c.shortcut) map[c.name] = c.shortcut;
    }
  } catch {
    /* commands API unavailable */
  }
  return map;
}

// Prepend each capture button's shortcut to its tooltip, once getAll resolves.
// Done AFTER the synchronous render so a cold service worker can never delay the
// popup paint — Firefox would otherwise show an empty popup on the first click.
function applyShortcutTooltips(byCommand) {
  captureShortcuts().then((sc) => {
    for (const [name, btn] of Object.entries(byCommand)) {
      if (!sc[name]) continue;
      const label = `${sc[name]} — ${btn.dataset.tip}`;
      btn.dataset.tip = label;
      btn.setAttribute('aria-label', label);
    }
  });
}

function buildToolbar() {
  // Brand (left): icon + wordmark.
  const brand = document.createElement('div');
  brand.className = 'brand';
  const logo = document.createElement('img');
  logo.src = 'icons/icon.svg';
  logo.alt = '';
  const name = document.createElement('span');
  name.textContent = 'SnapStack';
  brand.append(logo, name);

  // Actions (right): stack tools · separator · the three capture modes.
  // Capture order, right-to-left = normal · area · full page.
  const copyAllBtn = iconButton('copy', t('toolbarCopyAll'), () =>
    copyText(state.items.map((i) => i.path).join('\n'), copyAllBtn, 'copy'),
  );
  const sep = document.createElement('span');
  sep.className = 'sep';
  const clearAllBtn = iconButton('trash', t('toolbarDeleteAll'), onClearAll);
  const fullBtn = iconButton('fullpage', t('toolbarCaptureFull'), onCaptureFull);
  const zoneBtn = iconButton('crop', t('toolbarCaptureZone'), onCaptureZone);
  const captureBtn = iconButton('camera', t('toolbarCapture'), onCapture);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    iconButton('gear', t('toolbarOpenSettings'), onOpenSettings),
    iconButton('folder', t('toolbarOpenFolder'), onReveal),
    clearAllBtn,
    copyAllBtn,
    sep,
    fullBtn,
    zoneBtn,
    captureBtn,
  );

  toolbarBtns.clear = clearAllBtn;
  toolbarBtns.copyAll = copyAllBtn;
  setStackButtons(state.items.length > 0);

  toolbarEl.replaceChildren(brand, actions);
  applyShortcutTooltips({ 'capture-full': fullBtn, 'capture-zone': zoneBtn, capture: captureBtn });
}

// --- toolbar actions -------------------------------------------------------
// Mutations are delegated to the background worker so they complete even when a
// native confirm() / new tab closes the popup (its dispatch is synchronous).
async function onClearAll() {
  if (!confirm(t('confirmDeleteAll'))) return;
  try {
    await api.runtime.sendMessage({ type: 'clear' });
    await load();
  } catch {
    /* popup torn down — background still performs the clear */
  }
}

function onReveal() {
  api.runtime.sendMessage({ type: 'reveal' });
}

// Open the extension's options page (full tab) and close the popup. Settings live
// there: the shared server-owned capture policy + this browser's local serverBase.
function onOpenSettings() {
  api.runtime.openOptionsPage();
  window.close();
}

async function onCapture() {
  const res = await api.runtime.sendMessage({ type: 'capture' });
  if (res?.ok) await load();
}

// Hand off to the background worker and close the popup immediately: the
// selection happens on the page, where an open popup would only get in the way
// (and would close on its own the moment the page takes focus). The badge
// resyncs on its own once the capture lands.
function onCaptureZone() {
  api.runtime.sendMessage({ type: 'capture-zone' });
  window.close();
}

// Same hand-off as the zone capture: the background worker scrolls the page and
// stitches the slices (a multi-second job), so close the popup immediately and
// let the badge resync once the capture lands.
function onCaptureFull() {
  api.runtime.sendMessage({ type: 'capture-full' });
  window.close();
}

// --- grid ------------------------------------------------------------------
function makeCell(item) {
  const cell = document.createElement('div');
  cell.className = 'cell';

  const img = document.createElement('img');
  img.src = `${state.base}/file/${encodeURIComponent(item.name)}`;
  img.alt = item.title || item.url || item.name;
  cell.append(img);

  // Stable capture number, top-left — lets the user match a preview to the
  // number used by the MCP tools. Legacy unnumbered files get no badge.
  if (item.number != null) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(item.number).padStart(2, '0');
    cell.append(badge);
  }

  const controls = document.createElement('div');
  controls.className = 'controls';
  const delBtn = iconButton('trash', t('itemDelete'), (e) => {
    e.stopPropagation();
    deleteOne(item);
  });
  const copyBtn = iconButton('copy', t('itemCopyPath'), (e) => {
    e.stopPropagation();
    copyText(item.path, copyBtn, 'copy');
  });
  controls.append(delBtn, copyBtn);
  cell.append(controls);

  // Click the preview → open the image in a new tab.
  cell.addEventListener('click', () => {
    api.tabs.create({ url: `${state.base}/file/${encodeURIComponent(item.name)}` });
  });
  return cell;
}

async function deleteOne(item) {
  if (!confirm(t('confirmDeleteOne'))) return;
  try {
    await api.runtime.sendMessage({ type: 'delete', name: item.name });
    await load();
  } catch {
    /* popup torn down — background still performs the delete */
  }
}

function showMessage(text, isError) {
  const m = document.createElement('div');
  m.className = isError ? 'message error' : 'message';
  m.textContent = text;
  scrollEl.replaceChildren(m);
}

function renderGrid(items) {
  if (!items.length) {
    showMessage(t('stackEmpty'));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.append(...items.map(makeCell));
  scrollEl.replaceChildren(grid);
}

async function fetchList(base) {
  const r = await fetch(`${base}/list`);
  if (!r.ok) throw new Error(`list ${r.status}`);
  return r.json();
}

async function load() {
  const cfg = await getConfig();
  state.base = cfg.serverBase;

  let items;
  try {
    items = await fetchList(cfg.serverBase);
  } catch {
    showMessage(t('serverNotRunning'), true);
    setStackButtons(false);
    return;
  }

  state.items = items;
  setStackButtons(items.length > 0);
  renderGrid(items);
}

// Surface the version-skew nudge the background worker persists: an amber banner
// when the server's protocol is behind this extension (see background.js checkCompat).
async function showCompatBanner() {
  const banner = document.getElementById('banner');
  if (!banner) return;
  let reason = null;
  try {
    const stored = await api.storage?.local.get('serverCompat');
    reason = stored?.serverCompat ?? null;
  } catch {
    /* storage unavailable */
  }
  if (reason === 'outdated') {
    // "<statement> <update it →>" — the action word links to the update guide.
    const link = document.createElement('a');
    link.href = UPDATE_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('serverOutdatedAction');
    banner.replaceChildren(document.createTextNode(`${t('serverOutdated')} `), link);
    banner.hidden = false;
  } else {
    banner.replaceChildren();
    banner.hidden = true;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  buildToolbar();
  load();
  showCompatBanner();
});
