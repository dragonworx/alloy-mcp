# Alloy MCP

**Bond your AI agent to the Chrome you already use.**

Alloy MCP gives an MCP-capable agent 73 tools for driving your *existing* Chrome profile — logged-in sessions, extensions, cookies, and all. A local Bun server translates MCP tool calls into authenticated WebSocket requests handled by an unpacked Chrome extension.

```text
MCP client --stdio--> Bun server --authenticated WebSocket--> Chrome extension --> your Chrome profile
```

*Chrome is a metal; an alloy is what you get when you bond something to it.*

## Why

Most browser automation launches a clean, throwaway profile. That means logging in again, dismissing consent banners again, and re-navigating to the page you actually care about — on every run.

Alloy MCP attaches to the browser already open in front of you:

- **No re-authentication.** The agent inherits your live sessions, SSO, and MFA state.
- **No context rebuild.** Point the agent at the tab you are already looking at.
- **Real browser conditions.** Your extensions, your settings, your rendering.
- **You stay in the loop.** Every action lands in a window you are watching and can take over at any moment.

The trade-off is that this is a *development* tool, not a sandboxed CI runner. See [Security](#security).

## Requirements

| | |
| --- | --- |
| Runtime | Bun 1.3 or newer |
| Browser | Chrome 116 or newer |
| Client | Any MCP client — VS Code, Claude Code, Claude Desktop, Cursor, Cline, Codex, Gemini CLI |

## Setup

### 1. Install

From the repository root:

```bash
bun run setup
```

This installs the locked server dependencies and creates or reveals the local pairing token. Use `bun run install-server` when you only need to refresh dependencies.

### 2. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `extension/` directory.
5. Pin Alloy MCP so its connection state is visible.

For `file://` test fixtures, enable **Allow access to file URLs** on the extension details page.

### 3. Pair the extension

Generate or reveal the local pairing token:

```bash
bun run pair
```

Open the extension popup, paste the 64-character token, and select **Pair extension**. The token is stored in Chrome extension storage and in `~/.config/alloy-mcp/token` with owner-only permissions. It is never sent over the WebSocket.

Set `ALLOY_MCP_TOKEN` to use an externally managed token, or `ALLOY_MCP_TOKEN_FILE` to use another token file.

### 4. Configure one MCP client

> **One server only.** The MCP client owns the server process. Do not also run `bun run start` — both processes would compete for the same WebSocket port.

For **Claude Code**, run from this repository:

```bash
bun run add-to-claude
```

For **VS Code**, create `.vscode/mcp.json`:

```json
{
  "servers": {
    "alloy": {
      "command": "bun",
      "args": ["run", "server/src/server.ts"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

For a global installation available in every workspace, server startup instructions, Copilot Agent verification, and troubleshooting, follow the dedicated [VS Code and GitHub Copilot setup guide](doc/VSCODE-COPILOT.md).

For **any other MCP client**, configure `bun run /absolute/path/to/alloy-mcp/server/src/server.ts` as a stdio server.

See [doc/SETUP.md](doc/SETUP.md) for Claude Code, Claude Desktop, Cursor, Cline, Codex, Gemini CLI, and generic stdio configurations. It also covers GUI application paths, environment variables, development, and troubleshooting.

### 5. Verify

Call these tools from the MCP client, in order:

| Tool | Confirms |
| --- | --- |
| `ping` | The server process is alive |
| `health_check` | Pairing succeeded and a server-extension round trip works |
| `list_tabs` | Access to your live Chrome profile |

The extension badge shows `ON` only after mutual authentication. `PAIR` means the popup needs the matching token, `OFF` means the server is unavailable, and `...` means authentication is in progress.

## What It Covers

The 73-tool surface spans:

| Area | Examples |
| --- | --- |
| Tabs and navigation | `navigate`, `list_tabs`, `switch_tab`, `go_back`, `refresh_page` |
| DOM inspection | `get_page_content`, `query_selector`, `extract_links`, `get_computed_styles` |
| Trusted input | `click_element`, `fill_input`, `press_key`, `drag_and_drop`, `upload_file` |
| Screenshots | `take_screenshot` (viewport, full page, or selector), `capture_element` |
| Network | monitoring and logs, `block_request`, header rules |
| Storage | cookies, local/session storage, Cache Storage clearing |
| Observation | console/error capture, waits, DOM mutation observation, JavaScript evaluation |
| Emulation | geolocation, media and device metrics, dialogs, shadow DOM, same-origin iframes |
| Other | downloads, performance data, DOM-derived accessibility summary |

Pointer, hover, and keyboard input use the Chrome DevTools Protocol where browser-equivalent trusted events matter, so framework-controlled inputs behave as they would under a real user.

### Deliberate boundaries

Alloy MCP is built for fast authenticated-session development loops and targeted regression checks — it is **not** a Playwright or Chrome DevTools replacement. Not exposed: browser chrome UI and restricted `chrome://` pages, cross-origin or nested iframe targeting, native accessibility-tree queries, request/response bodies, tracing, coverage, video, PDF, or HAR, and any test runner or journey replay orchestration.

See [doc/API.md](doc/API.md) for the exact tool list, parameters, and limits.

## Common Commands

| Command | Purpose |
| --- | --- |
| `bun run setup` | Install locked dependencies and create or reveal the pairing token |
| `bun run pair` | Reveal the pairing token |
| `bun run check` | Typecheck, test, and parse extension scripts |
| `bun run test` | Run Bun unit/integration tests |
| `bun run build` | Bundle the server into `server/dist/` |
| `bun run start` | Run the server manually for debugging |
| `bun run dev` | Run the server with file watching |
| `bun run open-fixture` | Open the manual HTML fixture |
| `bun run remove-from-claude` | Remove the Claude Code registration |

Manual `start` and `dev` runs are for debugging when no MCP-managed server is active. Reload the unpacked extension after changing extension files.

## Output Files

Screenshot tools may only write to the configured output directory. It defaults to `./artifacts` relative to the server working directory. Override it with `ALLOY_MCP_OUTPUT_DIR`.

Paths supplied to tools are resolved inside that directory. The output tree must be owned by the current user and not group- or world-writable; traversal, symbolic-link escapes, non-regular files, and multiply linked files are rejected.

## Security

> This extension can inspect pages, read cookies, execute JavaScript, control tabs, and attach the Chrome debugger against your **real, logged-in profile**. Treat access to the pairing token as access to that profile.

Controls in place:

- The server binds only to localhost, and WebSocket upgrades require a `chrome-extension://` origin.
- Both peers prove possession of the pairing token with role- and phase-bound HMAC-SHA-256, finalized against a fresh server-issued confirmation nonce. The token itself is never transmitted, and a captured proof cannot be replayed as final confirmation.
- Only one pending or authenticated connection is accepted; handshakes time out, and message sizes are capped.
- The logger records tool names and protocol state only — never tool arguments, results, or browsing URLs.
- Reconnection is blocked until prior page hooks, debugger sessions, request rules, and monitor state are cleaned up.

Do not expose the WebSocket port through a tunnel, proxy, or container port mapping. Full trust model, token rotation, and reporting guidance: [SECURITY.md](SECURITY.md).

## Development

```bash
bun run check
bun run build
```

Tests cover authentication and replay rejection, lifecycle cleanup and debugger ordering, origin rejection, tool parity, stdio framing, screenshot bounds and stitching, path confinement, setup documentation, and an authenticated request round trip. Chrome-specific behavior still requires the manual acceptance pass in [doc/TESTING.md](doc/TESTING.md).

## License

MIT
