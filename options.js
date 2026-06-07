'use strict';

// Cross-browser namespace, same convention as background.js / popup.js.
const api = globalThis.browser ?? globalThis.chrome;
const t = (key, subs) => api.i18n?.getMessage(key, subs) || key;

// serverBase is LOCAL to this browser (chrome.storage.local). The capture policy
// (format / quality / maxEdge / maxSlices) is owned by the SERVER and shared
// across the user's browsers — edited here via GET/POST /config. POLICY_DEFAULTS
// only pre-fills the form when the server is unreachable; it mirrors the server's
// DEFAULT_POLICY and background.js's DEFAULTS.
const DEFAULTS = { serverBase: 'http://127.0.0.1:4123' };
const POLICY_DEFAULTS = { format: 'webp', quality: 0.85, maxEdge: 1568, maxSlices: 50 };

const $ = (id) => document.getElementById(id);

function localize() {
  document.title = t('optionsTitle');
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
}

function flash(el, text, isError) {
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  if (!isError && text) setTimeout(() => { el.textContent = ''; }, 1500);
}

// The address the shared (server) operations target: the live field value, so a
// freshly-typed address works immediately; falls back to the default.
function currentBase() {
  return ($('serverBase').value || '').trim() || DEFAULTS.serverBase;
}

function fillPolicy(p) {
  $('format').value = p.format;
  $('quality').value = p.quality;
  $('maxEdge').value = p.maxEdge;
  $('maxSlices').value = p.maxSlices;
}

function setSharedEnabled(on) {
  for (const id of ['format', 'quality', 'maxEdge', 'maxSlices', 'saveShared']) {
    $(id).disabled = !on;
  }
}

// Pull the effective policy from the server; disable the section (pre-filled with
// the defaults) if it can't be reached — offline, or a server predating /config.
async function loadPolicy() {
  try {
    const r = await fetch(`${currentBase()}/config`);
    if (!r.ok) throw new Error(String(r.status));
    fillPolicy({ ...POLICY_DEFAULTS, ...(await r.json()) });
    setSharedEnabled(true);
    flash($('sharedMsg'), '');
  } catch {
    fillPolicy(POLICY_DEFAULTS);
    setSharedEnabled(false);
    flash($('sharedMsg'), t('optionsServerUnreachable'), true);
  }
}

async function saveShared() {
  const policy = {
    format: $('format').value,
    quality: Number($('quality').value),
    maxEdge: Math.round(Number($('maxEdge').value)),
    maxSlices: Math.round(Number($('maxSlices').value)),
  };
  try {
    const r = await fetch(`${currentBase()}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    });
    if (!r.ok) throw new Error(String(r.status));
    fillPolicy({ ...POLICY_DEFAULTS, ...(await r.json()) });
    flash($('sharedMsg'), t('optionsSaved'));
  } catch {
    flash($('sharedMsg'), t('optionsSaveError'), true);
  }
}

async function loadLocal() {
  let serverBase = DEFAULTS.serverBase;
  try {
    ({ serverBase = DEFAULTS.serverBase } = await api.storage.local.get(DEFAULTS));
  } catch {
    /* storage unavailable → default */
  }
  $('serverBase').value = serverBase;
}

async function saveLocal() {
  try {
    await api.storage.local.set({ serverBase: currentBase() });
    flash($('localMsg'), t('optionsSaved'));
  } catch {
    flash($('localMsg'), t('optionsSaveError'), true);
  }
  // The server address may have changed → re-pull the shared policy from it.
  await loadPolicy();
}

async function loadShortcut() {
  let shortcut = '';
  try {
    const cmds = await api.commands.getAll();
    shortcut = (cmds.find((c) => c.name === 'capture') || {}).shortcut || '';
  } catch {
    /* commands API unavailable */
  }
  $('shortcut').textContent = shortcut || t('optionsShortcutNone');
}

// Open the browser's extension-shortcuts UI. Chrome/Edge expose a deep link;
// Firefox has no stable one, so fall back to its add-ons manager. Best-effort.
function openShortcuts() {
  const url = globalThis.browser ? 'about:addons' : 'chrome://extensions/shortcuts';
  api.tabs.create({ url }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', async () => {
  localize();
  await loadLocal();
  await Promise.all([loadPolicy(), loadShortcut()]);
  $('saveShared').addEventListener('click', saveShared);
  $('saveLocal').addEventListener('click', saveLocal);
  $('editShortcut').addEventListener('click', openShortcuts);
});
