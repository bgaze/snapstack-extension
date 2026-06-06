<p align="center">
  <img src="assets/logo.png" alt="snapstack" width="440">
</p>

The **snapstack browser extension** captures the visible tab and stacks the screenshots locally, so any
MCP-capable LLM client can retrieve them on demand. One click (or `Cmd/Ctrl+Shift+S`) → the capture is stacked;
your LLM asks for the screenshots → it gets them in order, then the stack is cleared.

**Fully local**: captures are sent only to a server on `127.0.0.1`, no data ever leaves your machine.

> This is the **extension** half of snapstack. It needs the companion **local server** to receive and serve the
> captures: **[snapstack-server](https://github.com/bgaze/snapstack-server)**.

## How it works

```
[this extension]  --POST /push (bytes)-->  ┐
                                           ▼
                             [snapstack server]   127.0.0.1:4123
                                ├─ writes ─►  ~/.snapstack/   (FIFO stack on disk)
                                └─ MCP /mcp (HTTP)  ◄── MCP client
```

The extension encodes each capture as **WebP** (automatic **PNG** fallback if the browser can't encode WebP),
downscales it if needed, and POSTs it to the server. The server stacks it on disk; your MCP client retrieves the
whole stack through the [snapstack-server](https://github.com/bgaze/snapstack-server) MCP tools.

## Requirements

- A **Chrome**, **Edge**, or **Firefox** browser.
- The **[snapstack-server](https://github.com/bgaze/snapstack-server)** running locally (it receives the captures
  and exposes them to your LLM client).

## Installing the extension

The extension source is a single codebase compatible with Chrome / Edge / Firefox.

- **Chrome / Edge**: `chrome://extensions` (or `edge://extensions`) → enable **Developer mode** → **Load unpacked** →
  select this folder.
  *(An "Unrecognized manifest key 'background.scripts'" warning is expected and harmless: that key is for Firefox,
  Chrome uses `service_worker`.)*
- **Firefox**: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → select `manifest.json`.

## Using the dropdown

Click the extension icon to open the dropdown. It shows the stacked captures (or an empty state); take a capture with
the **Capture** button in the toolbar.

- **Toolbar** (top, right-aligned):
    - **Delete all** — clears the whole stack (after confirmation).
    - **Open folder** — opens the stack folder in your OS file manager.
    - **Copy all paths** — copies every capture's absolute path to the clipboard (one per line; green check on success).
    - **Capture** — takes a new capture of the current tab and stacks it.
- **Grid** — two previews per row. Hover a preview for **Delete** (after confirmation) and **Copy path** (absolute path,
  green check). **Click** a preview to open the full image in a new tab.

> Confirmations use the browser's native dialog, which closes the popup — this is expected; the action still completes.

The UI follows your **browser's language** (English, French, Spanish, German, Portuguese-BR, Italian, Japanese,
Simplified Chinese, Russian), falling back to English. The server and MCP outputs stay in English (they are read by the
LLM, which then answers you in your language).

## Normal flow

1. The [snapstack-server](https://github.com/bgaze/snapstack-server) is running.
2. While browsing, on each useful screen: **click** the icon → the dropdown opens; press **Capture** → the capture is
   stacked, the badge increments. The dropdown also lets you review, delete, copy paths, and open the folder.
3. In your MCP client: "retrieve my screenshots".
4. The LLM calls `get_screenshots` → receives the images in order → the stack is cleared, the badge resets to 0.

## Configuration

The extension reads these from `storage.local` (defaults shown):

| Key          | Default                 | Purpose                                                          |
|--------------|-------------------------|------------------------------------------------------------------|
| `serverBase` | `http://127.0.0.1:4123` | Capture server URL.                                              |
| `format`     | `webp`                  | `webp` or `png`.                                                 |
| `quality`    | `0.85`                  | WebP quality (lossy).                                            |
| `maxEdge`    | `1568`                  | Downscale the longest edge to this many px (`0` = no downscale). |

## Troubleshooting

- **"Capture server not started"** (shown in the dropdown / notification): start the server, or check its auto-start.
  See [snapstack-server](https://github.com/bgaze/snapstack-server).
- **Red `!` badge**: the extension can't reach the server. Check the port and that `host_permissions` covers the host.
- **Captures saved as PNG while `webp` is requested**: the browser (often Firefox, depending on the version) can't
  encode WebP → automatic PNG fallback, this is normal.

## License

MIT — see [LICENSE](./LICENSE).
