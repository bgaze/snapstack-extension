'use strict';

// Cross-browser namespace, same convention as background.js.
const api = globalThis.browser ?? globalThis.chrome;

// Localized UI string — resolved from _locales by the browser's UI language,
// with English (default_locale) as the built-in fallback.
const t = (key, subs) => api.i18n?.getMessage(key, subs) || key;

const DEFAULTS = { serverBase: 'http://127.0.0.1:4123' };

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
  check: '<polyline points="20 6 9 17 4 12"/>',
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

  // Actions (right) — order imposed by the spec: delete-all · open folder · copy all · capture.
  const copyAllBtn = iconButton('copy', t('toolbarCopyAll'), () =>
    copyText(state.items.map((i) => i.path).join('\n'), copyAllBtn, 'copy'),
  );
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    iconButton('trash', t('toolbarDeleteAll'), onClearAll),
    iconButton('folder', t('toolbarOpenFolder'), onReveal),
    copyAllBtn,
    iconButton('camera', t('toolbarCapture'), onCapture),
  );

  toolbarEl.replaceChildren(brand, actions);
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

async function onCapture() {
  const res = await api.runtime.sendMessage({ type: 'capture' });
  if (res?.ok) await load();
}

// --- grid ------------------------------------------------------------------
function makeCell(item) {
  const cell = document.createElement('div');
  cell.className = 'cell';

  const img = document.createElement('img');
  img.src = `${state.base}/file/${encodeURIComponent(item.name)}`;
  img.alt = item.title || item.url || item.name;
  cell.append(img);

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
    return;
  }

  state.items = items;
  renderGrid(items);
}

document.addEventListener('DOMContentLoaded', () => {
  buildToolbar();
  load();
});
