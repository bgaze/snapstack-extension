'use strict';

// snapstack — area-selection overlay. Injected on demand into the active tab by
// the background worker (scripting.executeScript). The worker photographs the
// visible tab FIRST and hands us that frozen still (a 'zone-still' message); we
// paint it as the backdrop so the user drags a rectangle over exactly the pixels
// already captured, then report the selected region (CSS px + devicePixelRatio)
// back to the worker, which crops the still to it. Freezing up front means an
// open dropdown / tooltip / hover menu can no longer vanish mid-selection. Runs
// in the isolated content-script world, so it can reach runtime messaging but
// never collides with the page's own scripts. Cross-browser namespace, same as
// the rest of the extension.
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
    // The frozen still, arriving via the 'zone-still' message, is painted here as
    // a full-viewport backdrop. Sized 100%×100% (the shot IS the viewport) so it
    // maps 1:1 to CSS px and the selection rectangle lines up with the crop.
    backgroundColor: 'transparent',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'top left',
    backgroundSize: '100% 100%',
  });

  // Pre-drag shade over the whole still, so it reads as "selection mode" before
  // any drag. Dropped the instant dragging starts — the rectangle's box-shadow
  // then dims everything OUTSIDE the selection, leaving the chosen zone clear.
  const dim = document.createElement('div');
  Object.assign(dim.style, {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0, 0, 0, 0.4)',
    pointerEvents: 'none',
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

  root.append(dim, rect, label);
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
    api.runtime.onMessage.removeListener(onStill);
    root.remove();
  }

  // Reports the outcome to the worker and removes the overlay.
  function finish(payload) {
    teardown();
    api.runtime.sendMessage(payload);
  }

  // Paint the frozen still handed over by the worker.
  function onStill(msg) {
    if (msg?.type !== 'zone-still' || !msg.img) return;
    root.style.backgroundImage = `url("${msg.img}")`;
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
    // Drop the full-screen shade; the rectangle's box-shadow now owns the dim so
    // the selection itself stays clear over the frozen still.
    dim.style.display = 'none';
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
    // The pixels were captured before this overlay ever appeared, so we just
    // report the rectangle — no need to hide the overlay first (the old flow had
    // to wait two frames for its dim to clear before a late captureVisibleTab).
    finish({
      type: 'zone-selected',
      rect: g,
      dpr: window.devicePixelRatio || 1,
    });
  });

  api.runtime.onMessage.addListener(onStill);
  window.addEventListener('keydown', onKey, true);
})();
