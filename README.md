<p align="center">
  <img src="assets/logo.png" alt="snapstack" width="440">
</p>

<p align="center">
  <a href="https://github.com/bgaze/snapstack-extension/actions/workflows/ci.yml"><img src="https://github.com/bgaze/snapstack-extension/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/bgaze/snapstack-extension?color=blue" alt="License: MIT"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-blueviolet" alt="MCP compatible"></a>
  <img src="https://img.shields.io/badge/100%25-local-success" alt="100% local">
</p>

<p align="center">
  Capture any browser tab in one click and stack it locally — your AI reads the screenshots on demand.
</p>

snapstack lets you hand browser screenshots to your AI assistant without copy-pasting images. Click the extension,
your shot is stacked locally; ask your LLM to "look at my screenshots" and it picks them up — through the
**Model Context Protocol (MCP)**, so it works with any MCP-capable client (Claude Code, and others).

**100% local.** Captures go only to a small server on your own machine (`127.0.0.1`). Nothing is ever uploaded,
no account, no telemetry. See [PRIVACY.md](./PRIVACY.md).

> snapstack has two halves: **this extension** (capture) and a small always-on **local server**
> ([snapstack-server](https://github.com/bgaze/snapstack-server)) that holds the stack and serves it to your LLM.
> Both install in a couple of minutes — see [Installation](#installation).

## How it works

```
[extension]  --click → capture-->  ┐
                                    ▼
                      [local server]   127.0.0.1
                         ├─ stores ─►  a folder on your disk
                         └─ MCP    ◄──  your LLM client asks for the screenshots
```

1. You browse and capture the screens you care about — they pile up in a local **stack**.
2. Your LLM client calls snapstack's MCP tools and gets a list of the pending shots.
3. It reads the ones it needs, straight from your disk. The captures stay until you clear them.

## Using it

Click the snapstack icon to open the dropdown:

- **Capture** — take a shot of the current tab and add it to the stack. The icon badge shows how many are stacked.
- **Capture area** — drag a rectangle over the page and stack just that region; press <kbd>Esc</kbd> to cancel.
  (Not available on browser-internal pages such as `chrome://` or the web store.)
- **Grid** — your captures, two per row, each tagged with its **number** (the handle your LLM uses). Hover for
  **Delete** / **Copy path**; click a shot to open it full-size.
- **Toolbar** — **Delete all**, **Open folder** (reveal the stack in your file manager), **Copy all paths**.

A typical session: capture a few screens → tell your AI *"have a look at my screenshots"* → it reads them and
answers. When you're done, clear them (from the dropdown, or let the AI do it).

The dropdown follows your **browser's language** (English, French, Spanish, German, Italian, Japanese,
Portuguese-BR, Russian, Simplified Chinese), falling back to English.

## Exposed MCP tools

Your LLM client uses these three tools — no image bytes are ever pushed to the model; it gets a lightweight list and
reads only the files it wants.

| Tool                | What it does                                                                                                                   |
|---------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `get_screenshots`   | Lists the pending captures (number, file path, size, page URL/title) — **read-only, never deletes**. Pass `numbers` (e.g. `[1,3]`) for specific ones. |
| `clear_screenshots` | Removes captures from the stack — specific `numbers`, or all of them. **The only destructive tool.**                            |
| `count_screenshots` | Just how many captures are waiting.                                                                                            |

## Installation

Three steps: **the server**, **your MCP client**, **this extension**.

### 1. Install the local server

> Needs **[Node.js](https://nodejs.org) ≥ 18** and **[git](https://git-scm.com)**.
> Check with `node -v` and `git --version`.

It's a permanent background tool, so it installs into your system's standard app location (not Downloads). Pick your
OS — copy the whole block and paste it into a terminal:

<details open>
<summary><b>macOS</b></summary>

```bash
# 1. Clone the server into the macOS app-support directory
git clone https://github.com/bgaze/snapstack-server.git "$HOME/Library/Application Support/snapstack"
cd "$HOME/Library/Application Support/snapstack"

# 2. Install dependencies (just two small packages)
npm install

# 3. Start it now + at every login, with crash-restart and auto-update (launchd)
./deploy/install-macos.sh
```
</details>

<details>
<summary><b>Linux</b></summary>

```bash
# 1. Clone the server into the standard data directory
git clone https://github.com/bgaze/snapstack-server.git "$HOME/.local/share/snapstack"
cd "$HOME/.local/share/snapstack"

# 2. Install dependencies (just two small packages)
npm install

# 3. Start it now + at every login, with restart and auto-update (systemd --user)
./deploy/install-linux.sh
```
</details>

<details>
<summary><b>Windows</b> (PowerShell)</summary>

```powershell
# 1. Clone the server into your local app data
git clone https://github.com/bgaze/snapstack-server.git "$env:LOCALAPPDATA\snapstack"
Set-Location "$env:LOCALAPPDATA\snapstack"

# 2. Install dependencies (just two small packages)
npm install

# 3. Start it now + at every login, with auto-update (scheduled task)
.\deploy\install-windows.ps1
```
</details>

That's it — the server now starts on login and **updates itself** (`git pull`) each time it launches. To run it just
once instead, skip step 3 and use `npm start`.

### 2. Register snapstack with your MCP client

The server speaks MCP over HTTP at **`http://127.0.0.1:4123/mcp`** (it must be running first).

**Claude Code** — one command:

```bash
claude mcp add --transport http --scope user snapstack http://127.0.0.1:4123/mcp
```

**Other clients** — add an HTTP MCP server; most accept this shape (consult your client's docs for the exact syntax):

```json
{
  "mcpServers": {
    "snapstack": { "type": "http", "url": "http://127.0.0.1:4123/mcp" }
  }
}
```

### 3. Install the extension

<!-- TODO: replace the placeholder URLs once the stores approve the listings -->

| Browser | Install |
|---------|---------|
| **Chrome** | [Chrome Web Store](https://CHROME_WEB_STORE_URL) |
| **Edge** | [Edge Add-ons](https://EDGE_ADDONS_URL) *(or install from the Chrome Web Store)* |
| **Firefox** | [Firefox Add-ons](https://FIREFOX_AMO_URL) |

<details>
<summary>Developer install (unpacked, from source)</summary>

- **Chrome / Edge**: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
  *(A harmless "Unrecognized manifest key 'background.scripts'" warning is expected — that key is for Firefox.)*
- **Firefox**: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → select `manifest.json`.
</details>

## Use it with Claude

Two touches make snapstack feel native in **Claude Code**.

**Skip the per-call confirmation** — allow the tools up front. Add to `~/.claude/settings.json` (covers every project):

```json
{
  "permissions": {
    "allow": [
      "mcp__snapstack__count_screenshots",
      "mcp__snapstack__get_screenshots",
      "mcp__snapstack__clear_screenshots"
    ]
  }
}
```

`get_screenshots` and `count_screenshots` are read-only; `clear_screenshots` is the only one that deletes — leave it
out of the list if you'd rather confirm deletions by hand.

**Add a `snap` shortcut** — drop this in your `~/.claude/CLAUDE.md` so a single word pulls in your captures:

```markdown
## snap shortcut
When I type `snap` (optionally with capture numbers and/or an instruction):
call `get_screenshots` to fetch the pending captures, then act on them in
context. `snap clear` (or `snap clear 01 02`) → `clear_screenshots`.
```

Now you just capture in the browser and type `snap` — Claude reads exactly what's on your screen.

## Troubleshooting

- **"Capture server not started"** — the local server isn't running. Start it (or check its auto-start);
  see [snapstack-server](https://github.com/bgaze/snapstack-server).
- **Red `!` badge** — the extension can't reach the server. Make sure it's running on `127.0.0.1:4123`.
- **Captures saved as PNG** — your browser can't encode WebP, so snapstack falls back to PNG automatically. Normal.

<details>
<summary>Advanced settings</summary>

The defaults work out of the box. Power users can tweak these via the extension's `storage.local`:
`serverBase` (`http://127.0.0.1:4123`), `format` (`webp`/`png`), `quality` (`0.85`), `maxEdge` (`1568` px,
`0` = no downscale).
</details>

## Packaging for the stores

The committed `manifest.json` carries both `background.service_worker` (Chrome) and `background.scripts`
(Firefox) so it loads unpacked in either browser. A store package must carry only its own browser's key,
so build per-browser bundles:

```bash
npm install      # dev-only: eslint
npm run build    # → dist/chrome/ + dist/firefox/ and a zip for each
```

`dist/snapstack-chrome-<version>.zip` goes to the Chrome Web Store / Edge Add-ons;
`dist/snapstack-firefox-<version>.zip` to Firefox AMO. Requires the system `zip`.

## Privacy & License

No data collection, nothing leaves `127.0.0.1`. See [PRIVACY.md](./PRIVACY.md). MIT — see [LICENSE](./LICENSE).
