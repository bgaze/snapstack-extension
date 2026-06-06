'use strict';

// snapstack — area-selection overlay. Injected on demand into the active tab by
// the background worker (scripting.executeScript). Lets the user drag a
// rectangle, then reports the selected region (CSS px + devicePixelRatio) back
// to the worker, which crops the visible-tab capture to it. Runs in the
// isolated content-script world, so it can reach runtime.sendMessage but never
// collides with the page's own scripts. Cross-browser namespace, same as the
// rest of the extension.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const OVERLAY_ID = 'snapstack-zone-overlay';
  const MIN_SIZE = 8; // px — smaller selections are treated as an accidental click

  // Idempotent: a second trigger tears down the previous overlay first.
  document.getElementById(OVERLAY_ID)?.remove();

  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    margin: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    // Dim the whole viewport the instant the overlay appears, so it reads as
    // "selection mode" before any drag. Once dragging starts this is dropped
    // and the rectangle's box-shadow takes over, leaving the selection clear.
    background: 'rgba(0, 0, 0, 0.4)',
  });

  // The selection rectangle: a transparent box whose huge box-shadow dims
  // everything outside it, so the chosen zone reads as a clear cut-out.
  const rect = document.createElement('div');
  Object.assign(rect.style, {
    position: 'fixed',
    display: 'none',
    boxSizing: 'border-box',
    border: '1px solid #fff',
    boxShadow: '0 0 0 100vmax rgba(0, 0, 0, 0.4)',
    pointerEvents: 'none',
  });

  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'fixed',
    display: 'none',
    zIndex: '1',
    padding: '2px 6px',
    borderRadius: '4px',
    background: 'rgba(17, 24, 39, 0.92)',
    color: '#fff',
    font: '600 12px/1.4 ui-monospace, Menlo, monospace',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  });

  root.append(rect, label);
  document.documentElement.append(root);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  // Normalized rectangle (CSS px) regardless of drag direction.
  const geom = (e) => ({
    x: Math.min(startX, e.clientX),
    y: Math.min(startY, e.clientY),
    w: Math.abs(e.clientX - startX),
    h: Math.abs(e.clientY - startY),
  });

  function teardown() {
    window.removeEventListener('keydown', onKey, true);
    root.remove();
  }

  // Reports the outcome to the worker and removes the overlay.
  function finish(payload) {
    teardown();
    api.runtime.sendMessage(payload);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish({ type: 'zone-cancelled' });
    }
  }

  function paint(e) {
    const g = geom(e);
    Object.assign(rect.style, {
      left: `${g.x}px`,
      top: `${g.y}px`,
      width: `${g.w}px`,
      height: `${g.h}px`,
    });
    label.textContent = `${g.w} × ${g.h}`;
    // Just below-right of the cursor, clamped inside the viewport.
    label.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 84)}px`;
    label.style.top = `${Math.min(e.clientY + 12, window.innerHeight - 26)}px`;
  }

  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    // Hand the dim over to the rectangle's box-shadow so the selection itself
    // stays clear (the root's full-screen dim would otherwise cover it too).
    root.style.background = 'transparent';
    rect.style.display = 'block';
    label.style.display = 'block';
    paint(e);
  });

  root.addEventListener('mousemove', (e) => {
    if (dragging) paint(e);
  });

  root.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const g = geom(e);
    if (g.w < MIN_SIZE || g.h < MIN_SIZE) {
      finish({ type: 'zone-cancelled' });
      return;
    }
    // Hide the overlay and wait two frames so the dim is fully gone before the
    // worker grabs captureVisibleTab — otherwise it would photograph the dim.
    root.style.display = 'none';
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        finish({
          type: 'zone-selected',
          rect: g,
          dpr: window.devicePixelRatio || 1,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        }),
      ),
    );
  });

  window.addEventListener('keydown', onKey, true);
})();
