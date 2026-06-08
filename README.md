<p align="center">
  <img src="assets/logo.png" alt="SnapStack" width="440">
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

<p align="center">
  <img src="assets/demo.gif" alt="SnapStack demo — capture a browser tab, your AI reads the screenshots over MCP" width="900">
</p>

SnapStack lets you hand browser screenshots to your AI assistant without copy-pasting images. Click the extension,
your shot is stacked locally; ask your LLM to "look at my screenshots" and it picks them up — through the
**Model Context Protocol (MCP)**, so it works with any MCP-capable client (Claude Code, and others).

**100% local.** Captures go only to a small server on your own machine (`127.0.0.1`). Nothing is ever uploaded,
no account, no telemetry. See [PRIVACY.md](./PRIVACY.md).

> SnapStack has two halves: **this extension** (capture) and a small always-on **local server**
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
2. Your LLM client calls SnapStack's MCP tools and gets a list of the pending shots.
3. It reads the ones it needs, straight from your disk. The captures stay until you clear them.

The dropdown follows your **browser's language** (English, French, Spanish, German, Italian, Japanese,
Portuguese-BR, Russian, Simplified Chinese), falling back to English.

## Exposed MCP tools

Your LLM client uses these three tools — no image bytes are ever pushed to the model; it gets a lightweight list and
reads only the files it wants.

| Tool                | What it does                                                                                                                                          |
|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `get_screenshots`   | Lists the pending captures (number, file path, size, page URL/title) — **read-only, never deletes**. Pass `numbers` (e.g. `[1,3]`) for specific ones. |
| `clear_screenshots` | Removes captures from the stack — specific `numbers`, or all of them. **The only destructive tool.**                                                  |
| `count_screenshots` | Just how many captures are waiting.                                                                                                                   |

## Installation

Three steps: **the server**, **your MCP client**, **this extension**.

### 1. Install the local server

> [Node.js](https://nodejs.org) ≥ 18 required.

The server ships on npm. One command installs it as a background tool that starts on login, restarts on crash, and
updates itself on each launch — same on macOS, Linux and Windows:

```bash
npx -y snapstack-server@latest install
```

### 2. Register SnapStack with your MCP client

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

**Clients that only spawn a process** (stdio transport) — point them at the `snapstack-mcp` bin:

```json
{
  "mcpServers": {
    "snapstack": { "command": "npx", "args": ["-y", "-p", "snapstack-server", "snapstack-mcp"] }
  }
}
```

### 3. Install the extension

<!-- TODO: replace the placeholder URLs once the stores approve the listings -->

| Browser     | Install                                                                          |
|-------------|----------------------------------------------------------------------------------|
| **Chrome**  | [Chrome Web Store](https://CHROME_WEB_STORE_URL)                                 |
| **Edge**    | [Edge Add-ons](https://EDGE_ADDONS_URL) *(or install from the Chrome Web Store)* |
| **Firefox** | [Firefox Add-ons](https://FIREFOX_AMO_URL)                                       |

<details>
<summary>Developer install (unpacked, from source)</summary>

- **Chrome / Edge**: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
  *(A harmless "Unrecognized manifest key 'background.scripts'" warning is expected — that key is for Firefox.)*
- **Firefox**: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → select `manifest.json`.

</details>

## Use it with Claude

Two touches make SnapStack feel native in **Claude Code**.

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
- **Captures saved as PNG** — your browser can't encode WebP, so SnapStack falls back to PNG automatically. Normal.

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
