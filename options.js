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
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    const v = t(el.dataset.i18nTitle);
    el.title = v;
    el.setAttribute('aria-label', v);
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
  clearFieldErrors();
}

function clearFieldErrors() {
  for (const id of ['quality', 'maxEdge', 'maxSlices']) $(`err-${id}`).textContent = '';
}

// Client-side mirror of the server schema: a bad value surfaces INLINE at its
// field rather than as a generic server error at the bottom. Returns the valid
// policy, or null (with the offending fields flagged).
function readValidPolicy() {
  clearFieldErrors();
  const qStr = $('quality').value.trim();
  const meStr = $('maxEdge').value.trim();
  const msStr = $('maxSlices').value.trim();
  const q = Number(qStr);
  const me = Number(meStr);
  const ms = Number(msStr);
  let ok = true;
  if (qStr === '' || !Number.isFinite(q) || q < 0 || q > 1) {
    $('err-quality').textContent = t('optionsErrQuality');
    ok = false;
  }
  if (meStr === '' || !Number.isInteger(me) || me < 0) {
    $('err-maxEdge').textContent = t('optionsErrMaxEdge');
    ok = false;
  }
  if (msStr === '' || !Number.isInteger(ms) || ms < 1) {
    $('err-maxSlices').textContent = t('optionsErrMaxSlices');
    ok = false;
  }
  return ok ? { format: $('format').value, quality: q, maxEdge: me, maxSlices: ms } : null;
}

function setSharedEnabled(on) {
  for (const id of ['format', 'quality', 'maxEdge', 'maxSlices', 'saveShared', 'resetShared']) {
    $(id).disabled = !on;
  }
}

// Tracks the last known server reachability so the live poll only reacts to a
// change (and never clobbers values being edited).
let lastReachable = null;

// Pull the effective policy from the server; disable the section (pre-filled with
// the defaults) if it can't be reached — offline, or a server predating /config.
async function loadPolicy() {
  try {
    const r = await fetch(`${currentBase()}/config`);
    if (!r.ok) throw new Error(String(r.status));
    fillPolicy({ ...POLICY_DEFAULTS, ...(await r.json()) });
    setSharedEnabled(true);
    flash($('sharedMsg'), '');
    lastReachable = true;
  } catch {
    fillPolicy(POLICY_DEFAULTS);
    setSharedEnabled(false);
    flash($('sharedMsg'), t('optionsServerUnreachable'), true);
    lastReachable = false;
  }
}

// Keep the shared section in sync with the server's availability without a manual
// refresh — same spirit as the popup badge. Acts only on a reachability CHANGE,
// so it never overwrites values the user is editing; skipped while the server
// address itself is being edited (that field holds a half-typed value).
async function pollServer() {
  if (document.visibilityState !== 'visible' || !$('serverBase').readOnly) return;
  let reachable = false;
  let policy = null;
  try {
    const r = await fetch(`${currentBase()}/config`);
    if (r.ok) {
      reachable = true;
      policy = await r.json();
    }
  } catch {
    reachable = false;
  }
  if (reachable === lastReachable) return;
  lastReachable = reachable;
  if (reachable) {
    fillPolicy({ ...POLICY_DEFAULTS, ...policy });
    setSharedEnabled(true);
    flash($('sharedMsg'), '');
  } else {
    setSharedEnabled(false);
    flash($('sharedMsg'), t('optionsServerUnreachable'), true);
  }
}

async function saveShared() {
  const policy = readValidPolicy();
  if (!policy) return; // inline field errors shown; nothing to save
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

// serverBase is read-only until the user clicks edit; then save/cancel appear.
let serverBaseBackup = '';

function setServerEditing(on) {
  $('serverBase').readOnly = !on;
  $('editServer').hidden = on;
  $('saveServer').hidden = !on;
  $('cancelServer').hidden = !on;
  $('err-serverBase').textContent = '';
  if (on) $('serverBase').focus();
}

function startEditServer() {
  serverBaseBackup = $('serverBase').value;
  setServerEditing(true);
}

function cancelEditServer() {
  $('serverBase').value = serverBaseBackup;
  setServerEditing(false);
}

// Commit a new server address only after it validates AND actually answers — so a
// typo can't silently break capture.
async function saveServer() {
  const url = $('serverBase').value.trim();
  if (!/^https?:\/\/.+/i.test(url)) {
    $('err-serverBase').textContent = t('optionsErrServerUrl');
    return;
  }
  let reachable = false;
  try {
    reachable = (await fetch(`${url}/config`)).ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    $('err-serverBase').textContent = t('optionsErrServerDown');
    return;
  }
  try {
    await api.storage.local.set({ serverBase: url });
  } catch {
    /* storage unavailable */
  }
  setServerEditing(false);
  await loadPolicy(); // re-pull the shared policy from the new server
}

async function resetShared() {
  if (!confirm(t('confirmResetDefaults'))) return;
  try {
    const r = await fetch(`${currentBase()}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(POLICY_DEFAULTS),
    });
    if (!r.ok) throw new Error(String(r.status));
    fillPolicy({ ...POLICY_DEFAULTS, ...(await r.json()) });
    flash($('sharedMsg'), t('optionsSaved'));
  } catch {
    flash($('sharedMsg'), t('optionsSaveError'), true);
  }
}

const SHORTCUT_COMMANDS = ['capture', 'capture-zone', 'capture-full'];

// Show each capture command's current binding (one <code> per mode).
async function loadShortcuts() {
  const byName = {};
  try {
    for (const c of await api.commands.getAll()) byName[c.name] = c.shortcut || '';
  } catch {
    /* commands API unavailable */
  }
  for (const name of SHORTCUT_COMMANDS) {
    $(`sc-${name}`).textContent = byName[name] || t('optionsShortcutNone');
  }
}

// Reliable Firefox detection: the extension's own URL scheme (globalThis.browser
// is unreliable — it can be truthy in Chrome too).
function isFirefox() {
  try {
    return api.runtime.getURL('').startsWith('moz-extension://');
  } catch {
    return false;
  }
}

// Render a help string: lines split on \n, and a {url} marker becomes a link that
// opens that url via tabs.create. Works for chrome://… on Chrome/Edge; Firefox
// blocks about:addons, so there the link is informational (the steps guide the user).
function renderShortcutHelp(el, raw) {
  el.replaceChildren();
  raw.split('\n').forEach((line, i) => {
    if (i) el.appendChild(document.createElement('br'));
    const m = /^([\s\S]*)\{([\s\S]+)\}([\s\S]*)$/.exec(line);
    if (!m) {
      el.appendChild(document.createTextNode(line));
      return;
    }
    const url = m[2];
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = url;
    // Chrome/Edge open chrome:// via tabs.create. Firefox cannot open about:
    // pages at all (tabs.create is a no-op, links are blocked), so there a click
    // copies the address to paste manually.
    const copyOnly = isFirefox() && url.startsWith('about:');
    if (copyOnly) a.title = t('optionsCopyHint');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (!copyOnly) {
        api.tabs.create({ url }).catch(() => {});
        return;
      }
      navigator.clipboard?.writeText(url).then(() => {
        a.textContent = `${url} ✓`;
        setTimeout(() => { a.textContent = url; }, 1200);
      }).catch(() => {});
    });
    el.append(document.createTextNode(m[1]), a, document.createTextNode(m[3]));
  });
}

// Shortcuts are editable only in the browser's own UI (no in-page API on Chrome).
// Show the right instructions per browser — informational, no button.
function setupShortcutHelp() {
  renderShortcutHelp($('shortcutHelp'), isFirefox() ? t('optionsShortcutHintFirefox') : t('optionsShortcutHint'));
}

document.addEventListener('DOMContentLoaded', async () => {
  localize();
  setupShortcutHelp();
  await loadLocal();
  await Promise.all([loadPolicy(), loadShortcuts()]);
  $('saveShared').addEventListener('click', saveShared);
  $('resetShared').addEventListener('click', resetShared);
  $('editServer').addEventListener('click', startEditServer);
  $('saveServer').addEventListener('click', saveServer);
  $('cancelServer').addEventListener('click', cancelEditServer);

  // Live server-availability sync: poll while visible, and re-check instantly when
  // the tab regains focus (so starting/stopping the server reflects without a reload).
  setInterval(pollServer, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollServer();
  });
});
