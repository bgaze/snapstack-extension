#!/usr/bin/env node
// Package the extension for the stores. The repo manifest carries BOTH
// background.service_worker (Chrome MV3) and background.scripts (Firefox MV3) so
// it loads unpacked in either browser — but a store package must carry only its
// own browser's key (the Chrome Web Store validator rejects the MV2-only
// `scripts` key). This emits a per-browser dist/ folder + a zip for each.
//
// Zero runtime dependency: Node built-ins + the system `zip`.

import { readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// Runtime assets shipped in every package (the branding `assets/`, README,
// PRIVACY, scripts/ and dist/ are intentionally excluded).
const RUNTIME = ['background.js', 'popup.html', 'popup.css', 'popup.js', 'options.html', 'options.css', 'options.js', 'overlay.js', '_locales', 'icons'];

// Chrome: service_worker only; drop the Firefox-only gecko settings.
function chromeManifest(m) {
  const c = structuredClone(m);
  c.background = { service_worker: m.background.service_worker };
  delete c.browser_specific_settings;
  return c;
}

// Firefox: scripts only; keep browser_specific_settings (gecko id + data policy).
function firefoxManifest(m) {
  const f = structuredClone(m);
  f.background = { scripts: m.background.scripts };
  return f;
}

async function buildTarget(name, manifest, version) {
  const out = path.join(dist, name);
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const item of RUNTIME) {
    await cp(path.join(root, item), path.join(out, item), { recursive: true });
  }

  const zipPath = path.join(dist, `snapstack-${name}-${version}.zip`);
  try {
    execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: out, stdio: 'inherit' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('error: the `zip` command is required to package. Install it, or zip dist/' + name + '/ manually.');
      process.exit(1);
    }
    throw e;
  }
  console.log(`  ${name.padEnd(8)} → dist/${name}/  +  ${path.basename(zipPath)}`);
}

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const { version } = manifest;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

console.log(`Packaging snapstack ${version}:`);
await buildTarget('chrome', chromeManifest(manifest), version);
await buildTarget('firefox', firefoxManifest(manifest), version);
console.log('Done.');
