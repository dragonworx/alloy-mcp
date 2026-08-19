# VS Code And GitHub Copilot Setup

This guide installs Alloy MCP for GitHub Copilot Agent mode in VS Code. Alloy MCP has two local processes:

```text
Copilot Agent --stdio--> Bun MCP server --authenticated WebSocket--> Chrome extension
```

VS Code starts and owns the Bun server. The extension is loaded once into the Chrome profile that Copilot should control.

## Requirements

- Bun 1.3 or newer
- Chrome 116 or newer
- VS Code with GitHub Copilot Chat and MCP support enabled
- A local checkout of this repository

## Guided Setup

From the repository root, run:

```bash
bun run setup:vscode
```

This single interactive command performs the steps a person would otherwise do by hand:

1. Installs the exact dependencies from `server/bun.lock`.
2. Creates or reveals the pairing token and prints it.
3. Asks whether to register Alloy MCP for this workspace or for every workspace.
4. Resolves the absolute Bun path and repository paths for you.
5. Writes or updates the correct `mcp.json`, preserving any other servers already configured.
6. Prints the remaining manual steps: loading the Chrome extension, pairing, and starting the server.

Running it again is safe; it rewrites only the `alloy` entry. Useful flags:

| Flag | Effect |
| --- | --- |
| `--workspace` | Register in `.vscode/mcp.json` without prompting |
| `--global` | Register in the VS Code user configuration without prompting |
| `--print` | Show the configuration instead of writing any file |
| `--skip-install` | Skip the dependency install step |

If a user configuration already contains comments, the script leaves the file untouched and prints the `alloy` entry to paste manually.

The token file defaults to `~/.config/alloy-mcp/token`. Do not place the token in an MCP configuration file or commit it to source control.

Once the script finishes, complete the Chrome steps in [Load And Pair The Chrome Extension](#2-load-and-pair-the-chrome-extension), then [Start Alloy MCP](#4-start-alloy-mcp) and [Verify In Copilot Agent Mode](#5-verify-in-copilot-agent-mode). The numbered sections below document the same steps manually for reference.

## Manual Setup

### 1. Install And Create The Pairing Token

From the repository root, run:

```bash
bun run setup
```

This installs the exact dependencies from `server/bun.lock`, creates a random 256-bit pairing token if necessary, and prints the token. Running it again is safe.

The token file defaults to `~/.config/alloy-mcp/token`. Do not place the token in an MCP configuration file or commit it to source control.

### 2. Load And Pair The Chrome Extension
```
chrome://extensions
```

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `extension/` directory.
5. Open the Alloy MCP extension popup.
6. Paste the token printed by `bun run setup` and select **Pair extension**.

The extension cannot connect until VS Code starts the MCP server in step 4. A temporary `WebSocket connection to 'ws://localhost:3001/' failed` message before then is expected; the extension retries automatically.

For local `file://` pages, open the extension details and enable **Allow access to file URLs**.

### 3. Configure VS Code

Get the absolute Bun path:

```bash
command -v bun
```

Use absolute paths for a global configuration because VS Code may open a workspace outside this repository and GUI applications may not inherit the shell's `PATH`.

### Global Configuration

Use this option to make Alloy MCP available in every VS Code workspace:

1. Open the Command Palette with `Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows and Linux.
2. Run **MCP: Open User Configuration**.
3. Add the `alloy` entry below to the existing `servers` object.

```json
{
  "servers": {
    "alloy": {
      "type": "stdio",
      "command": "/absolute/path/to/bun",
      "args": [
        "run",
        "/absolute/path/to/alloy-mcp/server/src/server.ts"
      ],
      "env": {
        "ALLOY_MCP_OUTPUT_DIR": "/absolute/path/to/alloy-mcp/artifacts"
      }
    }
  }
}
```

Replace `/absolute/path/to/bun` with the output from `command -v bun` and `/absolute/path/to/alloy-mcp` with this repository's absolute path. Preserve any other entries already present in `servers`.

### Workspace Configuration

To enable Alloy MCP only in this repository, create `.vscode/mcp.json`:

```json
{
  "servers": {
    "alloy": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "server/src/server.ts"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

For another workspace, use the absolute-path global example inside that workspace's `.vscode/mcp.json`.

### 4. Start Alloy MCP

1. Open the Command Palette.
2. Run **MCP: List Servers**.
3. Select `alloy`.
4. Select **Start**.
5. Approve the Alloy MCP tools if VS Code prompts for permission.

The extension popup should change to connected and its badge should show `ON`. Do not also run `bun run start`; the VS Code-managed and manually started servers cannot both own port 3001.

Only start Alloy MCP in one VS Code window at a time. This installation controls one Chrome profile through one authenticated extension connection.

### 5. Verify In Copilot Agent Mode

Open Copilot Chat, select **Agent** mode, and ask:

```text
Use the Alloy MCP tools to run ping, health_check, and list_tabs.
```

Expected results:

1. `ping` confirms that VS Code started the Bun MCP process.
2. `health_check` confirms authenticated communication with the extension.
3. `list_tabs` returns tabs from the Chrome profile containing the extension.

A useful first browser task is:

```text
Use Alloy MCP to open https://example.com and describe the page.
```

## Daily Use

1. Open the Chrome profile containing the paired extension.
2. Start `alloy` from **MCP: List Servers** if it is stopped.
3. Use Copilot Agent mode and approve browser tools as required.

VS Code starts and stops the server process. The extension reconnects automatically when the server restarts.

## Troubleshooting

### WebSocket Connection Refused

The extension is running but the MCP server is not. Start `alloy` through **MCP: List Servers**. A refusal before the server starts is expected.

### Authentication Or Pairing Failure

From the repository root, reveal the current token:

```bash
bun run pair
```

Paste it into the extension popup, select **Pair extension**, and restart `alloy` from **MCP: List Servers**.

### VS Code Cannot Find Bun

Run `command -v bun` in a terminal and use that absolute path as the configuration's `command` value.

### Port 3001 Is Already In Use

Stop Alloy MCP in other VS Code windows and stop any manual `bun run start` or `bun run dev` process. Then start the server from the intended VS Code window.

### Tools Are Missing Or The Server Is Stale

Reload the VS Code window, open **MCP: List Servers**, and restart `alloy`. After changing extension files, also select **Reload** for Alloy MCP on `chrome://extensions`.

### Server-Only Diagnostic Run

When VS Code is not running Alloy MCP, the server can be started manually from the repository root:

```bash
bun run start
```

Stop the manual process before starting the VS Code-managed server.

For environment variables, other MCP clients, and local development workflows, see [SETUP.md](SETUP.md). For browser acceptance testing, see [TESTING.md](TESTING.md).
