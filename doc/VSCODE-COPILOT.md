# VS Code And GitHub Copilot Setup

This guide installs Chrome MCP for GitHub Copilot Agent mode in VS Code. Chrome MCP has two local processes:

```text
Copilot Agent --stdio--> Bun MCP server --authenticated WebSocket--> Chrome extension
```

VS Code starts and owns the Bun server. The extension is loaded once into the Chrome profile that Copilot should control.

## Requirements

- Bun 1.3 or newer
- Chrome 116 or newer
- VS Code with GitHub Copilot Chat and MCP support enabled
- A local checkout of this repository

## 1. Install And Create The Pairing Token

From the repository root, run:

```bash
bun run setup
```

This installs the exact dependencies from `server/bun.lock`, creates a random 256-bit pairing token if necessary, and prints the token. Running it again is safe.

The token file defaults to `~/.config/chrome-mcp/token`. Do not place the token in an MCP configuration file or commit it to source control.

## 2. Load And Pair The Chrome Extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `extension/` directory.
5. Open the Chrome MCP extension popup.
6. Paste the token printed by `bun run setup` and select **Pair extension**.

The extension cannot connect until VS Code starts the MCP server in step 4. A temporary `WebSocket connection to 'ws://localhost:3001/' failed` message before then is expected; the extension retries automatically.

For local `file://` pages, open the extension details and enable **Allow access to file URLs**.

## 3. Configure VS Code

Get the absolute Bun path:

```bash
command -v bun
```

Use absolute paths for a global configuration because VS Code may open a workspace outside this repository and GUI applications may not inherit the shell's `PATH`.

### Global Configuration

Use this option to make Chrome MCP available in every VS Code workspace:

1. Open the Command Palette with `Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows and Linux.
2. Run **MCP: Open User Configuration**.
3. Add the `chrome` entry below to the existing `servers` object.

```json
{
  "servers": {
    "chrome": {
      "type": "stdio",
      "command": "/absolute/path/to/bun",
      "args": [
        "run",
        "/absolute/path/to/chrome-mcp/server/src/server.ts"
      ],
      "env": {
        "CHROME_MCP_OUTPUT_DIR": "/absolute/path/to/chrome-mcp/artifacts"
      }
    }
  }
}
```

Replace `/absolute/path/to/bun` with the output from `command -v bun` and `/absolute/path/to/chrome-mcp` with this repository's absolute path. Preserve any other entries already present in `servers`.

### Workspace Configuration

To enable Chrome MCP only in this repository, create `.vscode/mcp.json`:

```json
{
  "servers": {
    "chrome": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "server/src/server.ts"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

For another workspace, use the absolute-path global example inside that workspace's `.vscode/mcp.json`.

## 4. Start Chrome MCP

1. Open the Command Palette.
2. Run **MCP: List Servers**.
3. Select `chrome`.
4. Select **Start**.
5. Approve the Chrome MCP tools if VS Code prompts for permission.

The extension popup should change to connected and its badge should show `ON`. Do not also run `bun run start`; the VS Code-managed and manually started servers cannot both own port 3001.

Only start Chrome MCP in one VS Code window at a time. This installation controls one Chrome profile through one authenticated extension connection.

## 5. Verify In Copilot Agent Mode

Open Copilot Chat, select **Agent** mode, and ask:

```text
Use the Chrome MCP tools to run ping, health_check, and list_tabs.
```

Expected results:

1. `ping` confirms that VS Code started the Bun MCP process.
2. `health_check` confirms authenticated communication with the extension.
3. `list_tabs` returns tabs from the Chrome profile containing the extension.

A useful first browser task is:

```text
Use Chrome MCP to open https://example.com and describe the page.
```

## Daily Use

1. Open the Chrome profile containing the paired extension.
2. Start `chrome` from **MCP: List Servers** if it is stopped.
3. Use Copilot Agent mode and approve browser tools as required.

VS Code starts and stops the server process. The extension reconnects automatically when the server restarts.

## Troubleshooting

### WebSocket Connection Refused

The extension is running but the MCP server is not. Start `chrome` through **MCP: List Servers**. A refusal before the server starts is expected.

### Authentication Or Pairing Failure

From the repository root, reveal the current token:

```bash
bun run pair
```

Paste it into the extension popup, select **Pair extension**, and restart `chrome` from **MCP: List Servers**.

### VS Code Cannot Find Bun

Run `command -v bun` in a terminal and use that absolute path as the configuration's `command` value.

### Port 3001 Is Already In Use

Stop Chrome MCP in other VS Code windows and stop any manual `bun run start` or `bun run dev` process. Then start the server from the intended VS Code window.

### Tools Are Missing Or The Server Is Stale

Reload the VS Code window, open **MCP: List Servers**, and restart `chrome`. After changing extension files, also select **Reload** for Chrome MCP on `chrome://extensions`.

### Server-Only Diagnostic Run

When VS Code is not running Chrome MCP, the server can be started manually from the repository root:

```bash
bun run start
```

Stop the manual process before starting the VS Code-managed server.

For environment variables, other MCP clients, and local development workflows, see [SETUP.md](SETUP.md). For browser acceptance testing, see [TESTING.md](TESTING.md).
