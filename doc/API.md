# API Reference

The server currently registers 73 MCP tools. Zod schemas in `server/src/tools.ts` are the parameter source of truth.

Unless a tool requires `tabId`, omitting it targets the active tab in the current window.

## Server

- `ping`
- `health_check`

## Tabs And Navigation

- `navigate`
- `create_tab`
- `close_tab`
- `list_tabs`
- `switch_tab`
- `go_back`
- `go_forward`
- `refresh_page`

Navigation listeners are installed before navigation is triggered. Full-document, history-state, and fragment navigation are recognized.

## DOM Inspection

- `get_page_content`
- `query_selector`
- `get_element_text`
- `extract_links`
- `extract_structured_data`
- `get_page_metadata`
- `get_computed_styles`
- `get_page_structure`

Content output is text or HTML. Structured-data extraction covers JSON-LD, Open Graph, and Twitter cards. `query_selector` returns at most 100 matches.

## Interaction

- `click_element`
- `fill_input`
- `select_option`
- `submit_form`
- `check_checkbox`
- `hover_element`
- `scroll_to`
- `focus_element`
- `press_key`
- `type_text`
- `dispatch_event`
- `drag_and_drop`
- `upload_file`

Pointer, hover, keyboard, and text insertion use the Chrome Debugger Protocol where browser-equivalent input matters. `fill_input` uses native input/textarea setters so controlled frameworks receive updates. `dispatch_event` and HTML drag/drop intentionally create synthetic DOM events. `drag_and_drop` requires either `targetSelector` or `targetCoordinates`; `steps` is an integer from 1 through 100.

## Screenshots

- `take_screenshot`
- `capture_element`

`take_screenshot` supports visible viewport, `fullPage`, or `selector` capture through rate-limited visible-tab tiles. The target tab is temporarily activated for each tile and the previously active tab is restored afterward. Capture fails if another tab becomes active during a tile. A single dimension may not exceed 4096 pixels, a capture may use at most 64 tiles, and encoded image data may not exceed 24 MiB.

When `filePath` is provided, it is relative to `CHROME_MCP_OUTPUT_DIR` (default `./artifacts`). The private output tree rejects traversal, symbolic links, non-regular targets, and multiply linked files. Otherwise the result is MCP image content.

## Network

- `start_network_monitoring`
- `stop_network_monitoring`
- `get_network_log`
- `block_request`
- `unblock_request`
- `modify_request_headers`
- `list_network_rules`
- `clear_network_rules`

Network monitoring provides request URL, method, resource type, response status, timestamp, and reported content length. It does not capture request/response bodies, HAR files, WebSocket frames, or service-worker internals.

Blocking/header tools create tab-scoped session rules. Use the list, remove, and clear tools to manage them explicitly; all remaining rules are removed when the MCP connection closes or the extension worker starts.

Before every connection attempt, the extension also restores tracked console/dialog page hooks, clears monitoring state, and releases debugger sessions. If cleanup fails, reconnection remains blocked.

## Cookies And Storage

- `get_cookies`
- `set_cookie`
- `delete_cookies`
- `get_local_storage`
- `set_local_storage`
- `get_session_storage`
- `clear_storage`

Cookie access follows Chrome extension host permissions and Chrome's partition/store behavior.
The `cache` storage type clears the page origin's Cache Storage API entries; it does not flush Chrome's HTTP cache.

## Wait And Observe

- `wait_for_element`
- `wait_for_navigation`
- `wait_for_condition`
- `observe_dom_changes`
- `start_console_monitoring`
- `stop_console_monitoring`
- `get_console_log`
- `clear_console_log`
- `get_error_log`

Page errors and unhandled rejections are captured from `document_start`. Console entries are captured only after `start_console_monitoring` and are bounded by `maxEntries`.

## JavaScript And Analysis

- `execute_javascript`
- `evaluate_expression`
- `get_performance_metrics`
- `check_element_visibility`
- `get_viewport_info`
- `detect_technology`
- `get_accessibility_tree`

JavaScript executes in the page's main execution context through CDP `Runtime.evaluate`, so page CSP does not block it. The accessibility result is a DOM/ARIA summary, not Chrome's native AX tree. Accessibility traversal is limited to depth 32 and 5,000 nodes.

## Browser State

- `set_geolocation`
- `clear_geolocation`
- `emulate_media`
- `set_device_metrics`
- `manage_dialogs`
- `query_iframe`
- `query_shadow_dom`

Geolocation, media, and device settings use persistent CDP sessions. Call `clear_geolocation`, or call `emulate_media` / `set_device_metrics` with no override fields, to reset and detach. Chrome DevTools and Chrome MCP cannot simultaneously own the same tab's debugger session.

Iframe operations are currently same-origin. Shadow DOM operations support open roots only.

## Downloads

- `trigger_download`
- `get_download_status`

## Deliberate Boundaries

The bridge is sufficient for fast authenticated-session development loops and targeted regression checks. It is not a full Playwright or Chrome DevTools replacement.

Not currently exposed:

- browser chrome UI, extension pages, and restricted `chrome://` pages
- cross-origin/nested iframe targeting
- native accessibility-tree queries
- request/response bodies, tracing, coverage, video, PDF, or HAR
- a test runner, assertions, journey recording, or replay orchestration
- multi-browser or non-Chromium support

Those higher-level features should be added only with Chrome integration tests and cleanup/reset semantics.
