# Privacy Policy — SnapStack browser extension

_Last updated: 2026-06-08_

**Summary: SnapStack collects no personal data and sends nothing to any remote server. Everything stays on your
machine.**

## What the extension does with data

When you explicitly take a capture (by clicking the extension or pressing the shortcut), the extension processes:

- the **image** of the visible browser tab, and
- the tab's **URL, title, and a timestamp** (stored as metadata alongside the image).

This data is sent **only** to the local SnapStack server running on your own computer at `http://127.0.0.1`, which
writes it to a folder on your disk. From there, your local MCP client retrieves it on demand.

## What we do NOT do

- **No remote transmission.** Data never leaves your computer. The extension only talks to `127.0.0.1` (localhost).
- **No third parties.** No servers, analytics, advertising, or tracking services are contacted.
- **No telemetry.** The extension reports nothing about you or your usage.
- **No accounts, no selling or sharing of data.** There is nothing to sign in to, and no data is monetized.

The Firefox build declares this formally in its manifest: `data_collection_permissions: { required: ["none"] }`.

## Permissions and why they are requested

| Permission                             | Why                                                                                                                                                           |
|----------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `activeTab`, `tabs`                    | Capture the visible tab's image and read its URL/title for the capture metadata.                                                                              |
| `scripting`                            | Inject the selection overlay for area capture and the scroll/measure steps for full-page capture, into the tab you capture.                                   |
| `host_permissions: http://127.0.0.1/*` | Send captures to, and load previews from, the **local** SnapStack server. Localhost only.                                                                     |
| `storage`                              | Save the local server's URL and a small server-compatibility flag locally. (The capture policy — format, quality, max width — lives on the server, not here.) |
| `notifications`                        | Warn you when the local server is unreachable.                                                                                                                |
| `alarms`                               | Periodically refresh the capture count shown on the toolbar badge.                                                                                            |
| `clipboardWrite`                       | Power the "Copy path" / "Copy all paths" buttons.                                                                                                             |

## Your control over the data

The captured data lives on your disk and is fully under your control. From the extension dropdown you can delete a
single capture, clear the whole stack, or open the folder. You can delete the local folder containing screenshots at any
time.

## Changes to this policy

If this policy changes, the updated version will be published in this repository with a new "Last updated" date.

## Contact

Questions about privacy? Open an issue at <https://github.com/bgaze/snapstack-extension/issues>.
