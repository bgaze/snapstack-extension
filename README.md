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

SnapStack lets you hand browser screenshots to your AI assistant without copy-pasting images.  
Click the extension, your shot is stacked locally; ask your LLM to "look at my screenshots" and it picks them up
over MCP.  
It works with any MCP-capable client (Claude Code and others).

**SnapStack is 100% local.**  
Captures go only to a small server on your own machine (`127.0.0.1`).  
Nothing is ever uploaded, no account, no telemetry. See [PRIVACY.md](./PRIVACY.md).

## How it works

SnapStack has two halves: this extension and a small always-on [local server](https://github.com/bgaze/snapstack-server)
that holds the stack and serves it to your LLM.  
Both install in a couple of minutes — see [Installation](#installation).

```
[extension] click → capture ┐
                            ▼
                      [local server]
                            ├─ stores →  a folder on your disk
                            └─ MCP    ←  your LLM client asks for the screenshots
```

1. You browse and capture the screens you care about — they pile up in a local **stack**.
2. Your LLM client calls SnapStack's MCP tools and gets a list of the pending shots.
3. It reads the ones it needs, straight from your disk. The captures stay until you clear them.

The dropdown follows your **browser's language**, falling back to English.  
Supported languages: English, French, Spanish, German, Italian, Japanese, Portuguese-BR, Russian, Simplified Chinese.

## Installation

### 1. Install the local server

> - [Node.js](https://nodejs.org) ≥ 18 required.
> - On Windows, **use an Administrator terminal**, otherwise the global npm install and the scheduled-task
>   registration may get rejected.

The server ships on npm and installation is straightforward on macOS, Linux and Windows:

1. Install globally: `npm i -g snapstack-server`
2. Enable background service: `snapstack enable`

SnapStack auto-starts on login, restarts on crash, and updates itself on each launch.  
To check its status or if an update is available, simply run `snapstack` in your terminal.

### 2. Register SnapStack with your MCP client

The server speaks MCP over HTTP at **`http://127.0.0.1:4123/mcp`**.

- **Claude Code**: `claude mcp add --transport http --scope user snapstack http://127.0.0.1:4123/mcp`
- **Other clients** — add an HTTP MCP server; most accept this shape (consult your client's docs for the exact
  syntax):
    ```json
    {
        "mcpServers": {
            "snapstack": { "type": "http", "url": "http://127.0.0.1:4123/mcp" }
        }
    }
    ```
- **Clients that only spawn a process** (stdio transport) — point them at the `snapstack mcp` command:
    ```json
    {
        "mcpServers": {
            "snapstack": { "command": "npx", "args": ["-y", "-p", "snapstack-server", "snapstack", "mcp"] }
        }
    }
    ```

### 3. Install the extension

| Browser     | Install                                                                                                                                           |
|-------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| **Chrome**  | [Chrome Web Store](https://chromewebstore.google.com/detail/ggpepmnkfmdignpnaedibnlalcfchmoc)                                                     |
| **Edge**    | via the [Chrome Web Store](https://chromewebstore.google.com/detail/ggpepmnkfmdignpnaedibnlalcfchmoc) — Edge installs Chrome Web Store extensions |
| **Firefox** | [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/snapstack/)                                                                            |

## Exposed MCP tools

Your LLM client uses these three tools — no image bytes are ever pushed to the model.
It gets a lightweight list and reads only the files it wants.

| Tool                | What it does                                                                                                                                          |
|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `get_screenshots`   | Lists the pending captures (number, file path, size, page URL/title) — **read-only, never deletes**. Pass `numbers` (e.g. `[1,3]`) for specific ones. |
| `clear_screenshots` | Removes captures from the stack — specific `numbers`, or all of them. **The only destructive tool.**                                                  |
| `count_screenshots` | Just how many captures are waiting.                                                                                                                   |

## Use it with Claude

Two touches make SnapStack feel native in **Claude Code**.

**Skip the per-call confirmation**

Add to `~/.claude/settings.json`:

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

**Add a `snap` shortcut**

Drop this in your `~/.claude/CLAUDE.md` so a single word pulls in your captures.  
Now you just capture in the browser and type `snap` — Claude reads exactly what's on your screen.

```markdown
## Snap

When the user types **`snap`** (alone, with an instruction, and/or with capture numbers): drive the **`snapstack` MCP
server** (`mcp__snapstack__*`) — retrieve/clear pending browser screenshots, then act in context.
`get_screenshots` returns a **read-only** JSON manifest (`number`, absolute `path`, `width`/`height`, `url`, `title`,
`capturedAt`, `format`, `bytes`) — no image bytes, never deletes; read a `path` only when you need the pixels.
`clear_screenshots` is the **only** deletion, always on demand.
Numbers are the two-digit badges; pass them as **integers** (`01 02 05` → `[1, 2, 5]`).

| Input                             | Action                                                        |
|-----------------------------------|---------------------------------------------------------------|
| `snap <instruction>`              | `get_screenshots` (all) → process **all** per the instruction |
| `snap 01 02 05 <instruction>`     | `get_screenshots {numbers:[1,2,5]}` → process **those**       |
| `snap clear` / `snap clear 01 02` | `clear_screenshots` (all / those)                             |
| `snap` (bare)                     | `get_screenshots` (all) → use per context                     |

**If MCP is unavailable, tools are deferred:** try `ToolSearch` (`select:mcp__snapstack__get_screenshots`); if still
missing, tell the user and fall back to the manual path (paste image / give a file path). Never block on `snap`.
```

## Troubleshooting

- **"Capture server not started"** — the local server isn't running. Start it (or check its auto-start);
  see [snapstack-server](https://github.com/bgaze/snapstack-server).
- **Red `!` badge** — the extension can't reach the server. Make sure it's running on `127.0.0.1:4123`.
- **Captures saved as PNG** — your browser can't encode WebP, so SnapStack falls back to PNG automatically. Normal.

## Support

- **A question or an idea?** → [GitHub Discussions](https://github.com/bgaze/snapstack-extension/discussions)
- **Found a bug?** → [open an issue](https://github.com/bgaze/snapstack-extension/issues)

## Privacy & License

No data collection, nothing leaves `127.0.0.1`. See [PRIVACY.md](./PRIVACY.md). MIT — see [LICENSE](./LICENSE).
