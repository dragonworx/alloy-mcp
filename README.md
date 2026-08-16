# Chrome MCP

Chrome MCP lets an MCP-capable AI agent automate the Chrome profile you already use. A local Bun server translates MCP tool calls into authenticated WebSocket requests handled by an unpacked Chrome extension.

```text
MCP client --stdio--> Bun server --authenticated WebSocket--> Chrome extension --> current Chrome profile
```

This avoids launching a fresh browser profile and repeating login or navigation steps during development.

## Requirements

- Bun 1.3 or newer
- Chrome 116 or newer
- An MCP client such as VS Code or Claude Code

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
5. Pin Chrome MCP so its connection state is visible.

For `file://` test fixtures, enable **Allow access to file URLs** on the extension details page.

### 3. Pair the extension

Generate or reveal the local pairing token:

```bash
bun run pair
```

Open the extension popup, paste the 64-character token, and select **Pair extension**. The token is stored in Chrome extension storage and in `~/.config/chrome-mcp/token` with owner-only permissions. It is never sent over the WebSocket.

Set `CHROME_MCP_TOKEN` to use an externally managed token, or `CHROME_MCP_TOKEN_FILE` to use another token file.

### 4. Configure one MCP client

The MCP client should own the server process. Do not also run `bun run start`; both processes would need the same WebSocket port.

For VS Code, create `.vscode/mcp.json`:

```json
{
  "servers": {
    "chrome": {
      "command": "bun",
      "args": ["run", "server/src/server.ts"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

For a global installation available in every workspace, server startup instructions, Copilot Agent verification, and troubleshooting, follow the dedicated [VS Code and GitHub Copilot setup guide](doc/VSCODE-COPILOT.md).

For Claude Code, run from this repository:

```bash
bun run add-to-claude
```

For another MCP client, configure `bun run /absolute/path/to/chrome-mcp/server/src/server.ts` as a stdio server.

See [doc/SETUP.md](doc/SETUP.md) for Claude Code, Claude Desktop, Cursor, Cline, Codex, Gemini CLI, and generic stdio configurations. It also covers GUI application paths, environment variables, development, and troubleshooting.

### 5. Verify

Call these tools from the MCP client:

1. `ping` confirms the server process.
2. `health_check` confirms pairing and a server-extension round trip.
3. `list_tabs` confirms access to the current Chrome profile.

The extension badge shows `ON` only after mutual authentication. `PAIR` means the popup needs the matching token.

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

## What It Covers

The 73-tool surface includes:

- tabs, navigation, history, and reloads
- DOM inspection, metadata, styles, links, and page structure
- trusted pointer and keyboard input, forms, drag/drop, and uploads
- viewport, element, and full-page screenshots
- cookies, local/session storage, and Cache Storage clearing
- network metadata, request blocking, and header rules
- console/error capture, waits, DOM observation, and JavaScript evaluation
- geolocation, media/device emulation, dialogs, shadow DOM, and same-origin iframes
- downloads, performance data, and a DOM-derived accessibility summary

See [doc/API.md](doc/API.md) for the exact list and limitations.

## Output Files

Screenshot tools may only write to the configured output directory. It defaults to `./artifacts` relative to the server working directory. Override it with `CHROME_MCP_OUTPUT_DIR`.

Paths supplied to tools are resolved inside that directory. The output tree must be owned by the current user and not group- or world-writable; traversal, symbolic-link escapes, non-regular files, and multiply linked files are rejected.

## Security

This extension can inspect pages, read cookies, execute JavaScript, control tabs, and attach the Chrome debugger. Treat access to the pairing token as access to the current browser profile.

The server binds only to localhost, accepts only Chrome-extension WebSocket origins, requires role- and phase-bound mutual HMAC authentication with a fresh final-confirmation nonce, limits message sizes, and does not log tool arguments or browsing URLs to disk. Reconnection is blocked until prior page hooks, debugger sessions, request rules, and monitor state are cleaned up. See [SECURITY.md](SECURITY.md).

## Development

```bash
bun run check
bun run build
```

Tests cover authentication and replay rejection, lifecycle cleanup and debugger ordering, origin rejection, tool parity, stdio framing, screenshot bounds and stitching, path confinement, setup documentation, and an authenticated request round trip. Chrome-specific behavior still requires the manual acceptance pass in [doc/TESTING.md](doc/TESTING.md).
