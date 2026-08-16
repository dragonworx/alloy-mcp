# Testing

## Automated Checks

From the repository root:

```bash
bun run check
bun run build
```

`bun run check` performs:

1. strict TypeScript compilation
2. all Bun unit and integration tests
3. syntax parsing for every extension script

The tests cover:

- pairing-token proof generation and replay-resistant final confirmation
- Chrome-extension origin admission
- successful mutual authentication and tool round trips
- rejection of page origins and incorrect pairing tokens
- MCP JSONL and `Content-Length` framing
- bounded JSONL and `Content-Length` input, idempotent stdio close, and failed writes
- tool-schema validation and extension-handler parity
- bridge failure classification and MCP image encoding
- negotiated screenshot dimensions, encoded payload limits, CSS-pixel normalization, and full-page tile stitching
- output path traversal, parent symbolic links, no-follow writes, and hard-link rejection
- extension cleanup barriers, page-hook restoration, and debugger generation ordering
- local documentation links, copyable JSON examples, and the locked setup command

No test requires a running Chrome instance.

## Manual Chrome Acceptance

Chrome extension APIs and trusted CDP input need one live-browser pass after changing `extension/` or a browser-facing schema.

1. Run `bun run check`.
2. Load or reload `extension/` from `chrome://extensions`.
3. Run `bun run pair` and pair the popup if needed.
4. Stop other Alloy MCP server processes.
5. Start the server through the MCP client being tested.
6. Confirm `health_check` reports an authenticated round trip.
7. Run `bun run open-fixture` and target that tab.

Recommended smoke sequence:

```text
list_tabs
get_page_metadata
query_selector { selector: "body" }
fill_input { selector: "#username", value: "test-user", tabId: ... }
click_element { selector: "#click-me", tabId: ... }
press_key { key: "Tab", tabId: ... }
take_screenshot { fullPage: true, tabId: ... }
get_error_log { tabId: ... }
```

Also verify:

- the extension badge is `ON` only while authenticated
- a wrong popup token produces `PAIR`, not `ON`
- element and full-page screenshots have different expected dimensions
- a React-controlled input observes `fill_input`
- CSS `:hover` responds to `hover_element`
- `emulate_media` changes `matchMedia`, then resets with no override fields
- `set_geolocation` changes the page API, then `clear_geolocation` restores it
- closing an emulated tab leaves no debugger attachment
- server shutdown frees port 3001

## One-Server Rule

The extension maintains one authenticated WebSocket connection. An MCP client normally starts its own stdio server, so do not run `bun run start` or `bun run dev` at the same time.

If startup reports `EADDRINUSE`, stop the existing owner. The server never kills another process automatically.

## Test Fixtures

- `test/test-target.html` covers forms, links, buttons, storage, and DOM queries.
- `test/test-keypress.html` is focused on keyboard behavior.

For local files, enable **Allow access to file URLs** in the extension details. Application-hosted fixtures are preferable for navigation and cookie tests.

## Adding A Tool

A browser-facing tool is complete only when:

1. its Zod schema is added to `server/src/tools.ts`
2. a same-named handler exists in `extension/background.js`
3. timeout, cleanup, and reset behavior are defined
4. `server/tests/tool-parity.test.ts` passes
5. the behavior is documented in `doc/API.md`
6. Chrome-dependent semantics receive a manual acceptance pass or an automated extension test
