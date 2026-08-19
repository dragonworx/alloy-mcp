# MCP Client And Local Development Setup

Alloy MCP consists of two local processes with one shared pairing token:

```text
agent --stdio--> Bun MCP server --localhost WebSocket--> Chrome extension
```

The agent starts and owns the Bun process. The extension is loaded once into the Chrome profile you want the agent to control.

## Quick Local Setup

From the repository root:

```bash
bun run setup
```

This command installs the exact dependencies in `server/bun.lock`, creates a 256-bit token when one does not exist, and prints the token. Then:

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the repository's `extension/` directory.
4. Open the Alloy MCP extension popup and paste the printed token.
5. Add one of the MCP client configurations below.
6. Restart or reload that MCP client, then call `ping`, `health_check`, and `list_tabs`.

The default token file is `~/.config/alloy-mcp/token`. Do not put the token in an MCP configuration file. Both processes read the same local token independently.

## Configuration Values

Terminal-based clients normally find `bun` through `PATH`. Desktop applications launched from Finder, Spotlight, or the Windows Start menu may not inherit that path. For those clients, get the executable path with:

```bash
command -v bun
```

In the examples below, replace:

- `/absolute/path/to/bun` with that command's output
- `/absolute/path/to/alloy-mcp` with this repository's absolute path

Use an absolute `ALLOY_MCP_OUTPUT_DIR` for clients that do not support a working directory. It keeps screenshots in the repository regardless of where the client starts the server.

## VS Code And GitHub Copilot

The fastest path is the guided script, which installs dependencies, provisions the token, resolves absolute paths, and writes the correct `mcp.json`:

```bash
bun run setup:vscode
```

Pass `--workspace` or `--global` to skip the prompt, `--print` to preview the configuration without writing it, and `--skip-install` to reuse existing dependencies. See the [VS Code and GitHub Copilot setup guide](VSCODE-COPILOT.md) for the full walkthrough.

To configure VS Code by hand, create `.vscode/mcp.json` in the workspace that should use Alloy MCP:

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

Open the **MCP: List Servers** command in VS Code, start `alloy`, and approve its tools when prompted. If VS Code cannot find Bun, replace `"bun"` with its absolute path.

When Alloy MCP lives outside the active workspace, use absolute server and output paths instead:

```json
{
  "servers": {
    "alloy": {
      "type": "stdio",
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/alloy-mcp/server/src/server.ts"],
      "env": {
        "ALLOY_MCP_OUTPUT_DIR": "/absolute/path/to/alloy-mcp/artifacts"
      }
    }
  }
}
```

## Claude Code

From this repository, register the server with the Claude Code CLI:

```bash
bun run add-to-claude
claude mcp get chrome
```

Remove the registration with `bun run remove-from-claude`. To share a project-scoped configuration instead, add `.mcp.json` to that project using the `mcpServers` form shown under [JSON-based clients](#json-based-clients).

## Claude Desktop

Open **Settings > Developer > Edit Config** and add the server under `mcpServers`. The usual configuration file locations are:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

Use the absolute-path JSON configuration below, save the file, and fully restart Claude Desktop.

## JSON-Based Clients

Cursor (`.cursor/mcp.json`), Cline's MCP server settings, Claude Desktop, Claude Code project `.mcp.json`, and Gemini CLI (`~/.gemini/settings.json`) accept the same stdio server fields under `mcpServers`:

```json
{
  "mcpServers": {
    "alloy": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/alloy-mcp/server/src/server.ts"],
      "env": {
        "ALLOY_MCP_OUTPUT_DIR": "/absolute/path/to/alloy-mcp/artifacts"
      }
    }
  }
}
```

For Cline, open **MCP Servers > Configure MCP Servers** and merge the `alloy` entry into the existing `mcpServers` object. For Cursor, open **Settings > Tools & Integrations > MCP** after saving the project file and enable `alloy`. For Gemini CLI, restart the CLI after editing its settings file and run `/mcp` to inspect the connection.

Do not replace an existing `mcpServers` object wholesale; merge the `alloy` property with any servers already configured.

## Codex CLI

Add this block to `~/.codex/config.toml`:

```toml
[mcp_servers.alloy]
command = "/absolute/path/to/bun"
args = ["run", "/absolute/path/to/alloy-mcp/server/src/server.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.alloy.env]
ALLOY_MCP_OUTPUT_DIR = "/absolute/path/to/alloy-mcp/artifacts"
```

Restart Codex and use its MCP server listing command to confirm that `alloy` is enabled.

## Any Other MCP Agent

Configure a local **stdio** transport with:

```text
command: /absolute/path/to/bun
arguments: run /absolute/path/to/alloy-mcp/server/src/server.ts
environment: ALLOY_MCP_OUTPUT_DIR=/absolute/path/to/alloy-mcp/artifacts
```

The client must send MCP over stdin/stdout and leave stderr available for diagnostics. Do not configure the localhost WebSocket as the MCP endpoint; that connection is private to the Chrome extension and uses a separate authenticated protocol.

## Local Development Loop

Run the complete local gate before starting work:

```bash
bun run check
bun run build
```

For server-only debugging without an MCP client:

```bash
bun run dev
```

`dev` watches TypeScript files and restarts the server. Stop it before enabling the server in an MCP client because only one server may own port 3001. For normal agent-driven development, let the MCP client run the non-watching command from its configuration and restart that MCP server after changing server code.

After changing extension code:

1. Open `chrome://extensions`.
2. Select **Reload** on Alloy MCP.
3. Restart the MCP server from the client.
4. Call `health_check` before testing other tools.

Use `bun run open-fixture` for the local HTML acceptance page. Enable **Allow access to file URLs** in the extension details before automating that page. The full manual browser acceptance sequence is in [TESTING.md](TESTING.md).

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `ALLOY_MCP_OUTPUT_DIR` | Absolute or working-directory-relative screenshot output directory |
| `ALLOY_MCP_TOKEN` | Externally managed 64-character hexadecimal token |
| `ALLOY_MCP_TOKEN_FILE` | Alternate pairing-token file path |

Prefer the owner-only token file created by `bun run setup`. Environment variables can be visible to process inspection and client diagnostics.

## Troubleshooting

### `ping` works but `health_check` fails

The MCP process is running, but the extension is not authenticated. Confirm the popup token matches `bun run pair`, reload the extension, and restart the MCP server.

### `bun` is not found

Use the absolute path from `command -v bun` in the client configuration. This is common for desktop applications that do not inherit an interactive shell's `PATH`.

### Port 3001 is already in use

Another MCP client, `bun run start`, or `bun run dev` already owns the extension connection. Stop it and let exactly one client start Alloy MCP. The server intentionally does not terminate other processes.

### The server connects to the wrong output directory

Set `ALLOY_MCP_OUTPUT_DIR` to an absolute path in the client configuration. Relative paths resolve from the client's server working directory.

### Tools do not reflect an extension edit

Reload Alloy MCP at `chrome://extensions`, then restart the MCP server. MV3 service workers can retain the previously loaded source until the extension is explicitly reloaded.