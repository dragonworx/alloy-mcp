# Security

Chrome MCP intentionally controls an already-authenticated browser profile. Its permissions are powerful: tabs, all page origins, scripting, cookies, downloads, request rules, and the Chrome debugger.

## Trust Model

Trust these components:

- the local MCP client and model allowed to call tools
- this server and unpacked extension source
- the user account that can read the pairing token

Do not expose the WebSocket port through a tunnel, proxy, container port mapping, or non-loopback bind.

## Pairing

The server creates a random 256-bit token at `~/.config/chrome-mcp/token` with mode `0600`, unless `CHROME_MCP_TOKEN` or `CHROME_MCP_TOKEN_FILE` is configured. File-based tokens are accepted only from a user-owned `0700` directory and a user-owned, singly linked regular file with no group or other access. Symbolic links are rejected.

The WebSocket protocol uses fresh server and extension nonces. Each peer proves possession of the token with a role- and phase-bound HMAC-SHA-256 proof. After the extension proof is verified, the server issues a fresh confirmation nonce; the extension's final proof is bound to that nonce and the distinct `extension-confirmation` phase. The token itself is never transmitted, and an initial or captured proof cannot be replayed as final confirmation.

The server does not consider a socket connected until the extension confirms the server proof. The extension ignores pings and tool requests until the server acknowledges that final confirmation.

To rotate the token:

1. Stop Chrome MCP servers.
2. Remove or replace the token file.
3. Run `bun run pair`.
4. Enter the new token in the extension popup.

Treat terminal output from `bun run pair` as sensitive.

## Transport Controls

- The server binds to `localhost` by default.
- WebSocket upgrades require a `chrome-extension://` origin.
- Only one pending or authenticated extension connection is accepted.
- Handshakes time out after five seconds.
- Incoming messages are capped at 32 MiB.
- Heartbeats close unresponsive authenticated connections.
- Disconnected tool calls fail immediately; commands are never deferred for later execution.
- Before startup or reconnection, the extension restores tracked page hooks, releases debugger sessions, removes request rules, and clears monitoring state. Cleanup failure prevents the socket from opening.

Origin filtering is defense in depth. Pairing authentication is the security boundary because a local process can spoof headers.

## Data Handling

Tool arguments may contain passwords, cookies, storage values, uploaded files, or JavaScript. The logger records tool names and protocol state only; it does not persist arguments, results, or browsing URLs.

Screenshot file output is confined to `CHROME_MCP_OUTPUT_DIR` (default `./artifacts`). The output tree must be owned by the current user and must not be group- or world-writable. Traversal, symbolic-link escapes, non-regular targets, and files with multiple hard links are rejected.

MCP image responses and tool results still pass through the configured MCP client and model. Apply that client's data-handling policy to any page being automated.

## Browser Indicators

The badge states are:

- `ON`: mutually authenticated
- `PAIR`: token missing or mismatched
- `OFF`: server unavailable
- `...`: socket open, authentication in progress

Chrome displays its debugger attachment banner while a tool owns a persistent emulation session. Reset emulation after a test.

## Reporting

When reporting a vulnerability, include the affected commit, Chrome/Bun versions, reproduction steps, and whether the attacker requires local account access or pairing-token access. Do not include real cookies, credentials, or captured page data.
