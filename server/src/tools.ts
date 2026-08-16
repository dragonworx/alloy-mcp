import { z } from "zod";

// Shared schemas
const optionalTabId = z.number().optional().describe("Target tab ID (defaults to active tab)");

// ─── Navigation Tools ────────────────────────────────────────────────
export const navigationTools = {
  navigate: {
    description: "Navigate to a URL in specified or current tab",
    schema: z.object({
      url: z.string().url().describe("URL to navigate to"),
      tabId: optionalTabId,
      waitForLoad: z.boolean().default(true).describe("Wait for page load to complete"),
    }),
  },
  create_tab: {
    description: "Open a new browser tab",
    schema: z.object({
      url: z.string().url().optional().describe("URL to open"),
      active: z.boolean().default(true).describe("Whether to focus the new tab"),
      windowId: z.number().optional().describe("Window to create tab in"),
    }),
  },
  close_tab: {
    description: "Close a specific tab",
    schema: z.object({
      tabId: z.number().describe("ID of the tab to close"),
    }),
  },
  list_tabs: {
    description: "Get information about all open tabs",
    schema: z.object({
      windowId: z.number().optional().describe("Filter by window ID"),
      activeOnly: z.boolean().default(false).describe("Only return active tabs"),
    }),
  },
  switch_tab: {
    description: "Focus a specific tab",
    schema: z.object({
      tabId: z.number().describe("ID of the tab to focus"),
    }),
  },
  go_back: {
    description: "Navigate backward in tab history",
    schema: z.object({ tabId: optionalTabId }),
  },
  go_forward: {
    description: "Navigate forward in tab history",
    schema: z.object({ tabId: optionalTabId }),
  },
  refresh_page: {
    description: "Reload the current page",
    schema: z.object({
      tabId: optionalTabId,
      bypassCache: z.boolean().default(false).describe("Bypass browser cache"),
    }),
  },
} as const;

// ─── DOM Reading Tools ───────────────────────────────────────────────
export const domReadingTools = {
  get_page_content: {
    description: "Extract page text or HTML",
    schema: z.object({
      format: z.enum(["text", "html"]).default("text").describe("Output format"),
      selector: z.string().optional().describe("CSS selector to scope content"),
      maxLength: z.number().int().min(1).max(5_000_000).default(1_000_000)
        .describe("Maximum characters returned"),
      tabId: optionalTabId,
    }),
  },
  query_selector: {
    description: "Find elements matching CSS selector",
    schema: z.object({
      selector: z.string().describe("CSS selector"),
      attributes: z.array(z.string()).optional().describe("Attributes to extract"),
      tabId: optionalTabId,
    }),
  },
  get_element_text: {
    description: "Get text content of specific element",
    schema: z.object({
      selector: z.string().describe("CSS selector for target element"),
      tabId: optionalTabId,
    }),
  },
  extract_links: {
    description: "Get all links on the page",
    schema: z.object({
      includeHidden: z.boolean().default(false).describe("Include hidden links"),
      tabId: optionalTabId,
    }),
  },
  extract_structured_data: {
    description: "Extract JSON-LD, Open Graph, and Twitter card metadata",
    schema: z.object({ tabId: optionalTabId }),
  },
  get_page_metadata: {
    description: "Get meta information about the page",
    schema: z.object({ tabId: optionalTabId }),
  },
  get_computed_styles: {
    description: "Get computed CSS styles for an element",
    schema: z.object({
      selector: z.string().describe("CSS selector"),
      properties: z.array(z.string()).optional().describe("Specific CSS properties"),
      tabId: optionalTabId,
    }),
  },
  get_page_structure: {
    description: "Get hierarchical structure of the page DOM",
    schema: z.object({
      maxDepth: z.number().int().min(0).max(20).default(5).describe("Maximum tree depth"),
      tabId: optionalTabId,
    }),
  },
} as const;

// ─── DOM Interaction Tools ───────────────────────────────────────────
export const domInteractionTools = {
  click_element: {
    description: "Click on an element",
    schema: z.object({
      selector: z.string().describe("CSS selector of element to click"),
      button: z.enum(["left", "right", "middle"]).default("left"),
      tabId: optionalTabId,
    }),
  },
  fill_input: {
    description: "Type into an input field",
    schema: z.object({
      selector: z.string().describe("CSS selector of input"),
      value: z.string().describe("Value to type"),
      clear: z.boolean().default(true).describe("Clear field before typing"),
      tabId: optionalTabId,
    }),
  },
  select_option: {
    description: "Select option from dropdown",
    schema: z.object({
      selector: z.string().describe("CSS selector of select element"),
      value: z.string().describe("Value or text of option to select"),
      tabId: optionalTabId,
    }),
  },
  submit_form: {
    description: "Submit a form",
    schema: z.object({
      selector: z.string().describe("CSS selector of form"),
      tabId: optionalTabId,
    }),
  },
  check_checkbox: {
    description: "Check or uncheck a checkbox",
    schema: z.object({
      selector: z.string().describe("CSS selector of checkbox"),
      checked: z.boolean().describe("Desired checked state"),
      tabId: optionalTabId,
    }),
  },
  hover_element: {
    description: "Trigger hover state on element",
    schema: z.object({
      selector: z.string().describe("CSS selector"),
      tabId: optionalTabId,
    }),
  },
  scroll_to: {
    description: "Scroll to element or coordinates",
    schema: z.object({
      selector: z.string().optional().describe("CSS selector to scroll to"),
      x: z.number().optional().describe("X coordinate"),
      y: z.number().optional().describe("Y coordinate"),
      behavior: z.enum(["auto", "smooth"]).default("auto"),
      tabId: optionalTabId,
    }),
  },
  focus_element: {
    description: "Focus on an input element",
    schema: z.object({
      selector: z.string().describe("CSS selector"),
      tabId: optionalTabId,
    }),
  },
} as const;

// ─── Screenshot Tools ────────────────────────────────────────────────
export const screenshotTools = {
  take_screenshot: {
    description: "Capture screenshot of visible area, full page, or specific element",
    schema: z.object({
      tabId: optionalTabId,
      format: z.enum(["png", "jpeg"]).default("png"),
      quality: z.number().min(0).max(100).default(90),
      fullPage: z.boolean().default(false),
      selector: z.string().optional().describe("CSS selector to capture"),
      filePath: z.string().optional().describe("Optional path relative to the configured output directory"),
    }),
  },
  capture_element: {
    description: "Screenshot a specific element",
    schema: z.object({
      selector: z.string().describe("CSS selector of element to capture"),
      tabId: optionalTabId,
      format: z.enum(["png", "jpeg"]).default("png"),
    }),
  },
} as const;

// ─── Network Monitoring Tools ────────────────────────────────────────
export const networkTools = {
  start_network_monitoring: {
    description: "Begin capturing network requests",
    schema: z.object({
      tabId: optionalTabId,
      filters: z
        .object({
          urlPatterns: z.array(z.string()).optional(),
          resourceTypes: z.array(z.string()).optional(),
        })
        .optional(),
    }),
  },
  stop_network_monitoring: {
    description: "Stop capturing and return network logs",
    schema: z.object({
      monitoringId: z.string().describe("Monitoring session ID"),
    }),
  },
  get_network_log: {
    description: "Get recent network activity",
    schema: z.object({
      tabId: optionalTabId,
      since: z.number().optional().describe("Timestamp to filter from"),
      limit: z.number().int().min(1).max(5000).default(100),
    }),
  },
  block_request: {
    description: "Block requests matching a URL pattern in one tab for this MCP session",
    schema: z.object({
      urlPattern: z.string().describe("URL pattern to block"),
      resourceTypes: z.array(z.string()).optional(),
      tabId: optionalTabId,
    }),
  },
  unblock_request: {
    description: "Remove a request blocking rule",
    schema: z.object({
      ruleId: z.number().int().positive().describe("ID of rule to remove"),
    }),
  },
  modify_request_headers: {
    description: "Add or modify request headers for matching URLs in one tab for this MCP session",
    schema: z.object({
      urlPattern: z.string().describe("URL pattern to match"),
      headers: z.record(z.string()).describe("Headers to set"),
      tabId: optionalTabId,
    }),
  },
  list_network_rules: {
    description: "List request rules active for this MCP session",
    schema: z.object({}),
  },
  clear_network_rules: {
    description: "Remove all request rules active for this MCP session",
    schema: z.object({}),
  },
} as const;

// ─── Storage & Cookie Tools ─────────────────────────────────────────
export const storageTools = {
  get_cookies: {
    description: "Retrieve cookies for a domain",
    schema: z.object({
      domain: z.string().optional(),
      name: z.string().optional(),
      tabId: optionalTabId,
    }),
  },
  set_cookie: {
    description: "Set a cookie",
    schema: z.object({
      url: z.string().url(),
      name: z.string(),
      value: z.string(),
      domain: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      expirationDate: z.number().optional(),
    }),
  },
  delete_cookies: {
    description: "Remove cookies",
    schema: z.object({
      url: z.string().url(),
      name: z.string().optional(),
    }),
  },
  get_local_storage: {
    description: "Read localStorage data",
    schema: z.object({
      key: z.string().optional(),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  set_local_storage: {
    description: "Write to localStorage",
    schema: z.object({
      key: z.string(),
      value: z.unknown(),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  get_session_storage: {
    description: "Read sessionStorage data",
    schema: z.object({
      key: z.string().optional(),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  clear_storage: {
    description: "Clear various storage types",
    schema: z.object({
      types: z.array(z.enum(["localStorage", "sessionStorage", "cookies", "cache"])),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
} as const;

// ─── Wait & Observe Tools ───────────────────────────────────────────
export const waitTools = {
  wait_for_element: {
    description: "Wait until an element appears in the DOM",
    schema: z.object({
      selector: z.string().describe("CSS selector to wait for"),
      timeout: z.number().int().min(100).max(110_000).default(30_000).describe("Timeout in ms"),
      tabId: optionalTabId,
    }),
  },
  wait_for_navigation: {
    description: "Wait for page load to complete",
    schema: z.object({
      timeout: z.number().int().min(100).max(110_000).default(30_000),
      tabId: optionalTabId,
    }),
  },
  wait_for_condition: {
    description: "Wait for a custom JavaScript condition to be truthy",
    schema: z.object({
      condition: z.string().describe("JavaScript expression to evaluate"),
      timeout: z.number().int().min(100).max(110_000).default(30_000),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  observe_dom_changes: {
    description: "Watch for DOM mutations over a duration",
    schema: z.object({
      selector: z.string().optional(),
      duration: z.number().int().min(100).max(110_000).describe("Observation duration in ms"),
      attributes: z.boolean().default(true),
      childList: z.boolean().default(true),
      subtree: z.boolean().default(true),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
} as const;

// ─── JavaScript Execution Tools ─────────────────────────────────────
export const jsTools = {
  execute_javascript: {
    description: "Run arbitrary JavaScript in page context",
    schema: z.object({
      code: z.string().describe("JavaScript code to execute"),
      args: z.array(z.unknown()).optional().describe("Arguments to pass"),
      tabId: optionalTabId,
    }),
  },
  evaluate_expression: {
    description: "Evaluate a JavaScript expression and return the result",
    schema: z.object({
      expression: z.string().describe("JavaScript expression"),
      tabId: optionalTabId,
    }),
  },
} as const;

// ─── Page Analysis Tools ────────────────────────────────────────────
export const analysisTools = {
  get_performance_metrics: {
    description: "Get page performance data (timing, navigation, memory)",
    schema: z.object({ tabId: optionalTabId }),
  },
  check_element_visibility: {
    description: "Determine if an element is visible and in the viewport",
    schema: z.object({
      selector: z.string().describe("CSS selector"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  get_viewport_info: {
    description: "Get viewport dimensions and scroll position",
    schema: z.object({ tabId: optionalTabId }),
  },
  detect_technology: {
    description: "Identify frameworks and technologies used on the page",
    schema: z.object({ tabId: optionalTabId }),
  },
} as const;

// ─── File & Download Tools ──────────────────────────────────────────
export const downloadTools = {
  trigger_download: {
    description: "Initiate a file download",
    schema: z.object({
      url: z.string().url(),
      filename: z.string().optional(),
      saveAs: z.boolean().default(false),
    }),
  },
  get_download_status: {
    description: "Check status of a download",
    schema: z.object({
      downloadId: z.number().describe("Download ID to check"),
    }),
  },
} as const;

// ─── Console Monitoring Tools ───────────────────────────────────────
export const consoleTools = {
  start_console_monitoring: {
    description: "Begin capturing console output (log, warn, error, info, debug, trace). Intercepts console methods in the page context.",
    schema: z.object({
      tabId: z.number().describe("Tab ID (required)"),
      levels: z.array(z.enum(["log", "warn", "error", "info", "debug", "trace"])).optional()
        .describe("Console levels to capture (defaults to all)"),
      maxEntries: z.number().int().min(1).max(5000).default(500).describe("Maximum entries to buffer"),
      includeStackTraces: z.boolean().default(false).describe("Include stack traces for errors"),
    }),
  },
  stop_console_monitoring: {
    description: "Stop capturing console output and return all captured entries",
    schema: z.object({
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  get_console_log: {
    description: "Get captured console entries without stopping monitoring",
    schema: z.object({
      tabId: z.number().describe("Tab ID (required)"),
      level: z.enum(["log", "warn", "error", "info", "debug", "trace", "all"]).default("all")
        .describe("Filter by level"),
      since: z.number().optional().describe("Timestamp to filter from"),
      limit: z.number().int().min(1).max(5000).default(100).describe("Maximum entries to return"),
      clear: z.boolean().default(false).describe("Clear buffer after reading"),
    }),
  },
  clear_console_log: {
    description: "Clear the captured console buffer without stopping monitoring",
    schema: z.object({
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
} as const;

// ─── Keyboard & Event Simulation Tools ──────────────────────────────
export const keyboardEventTools = {
  press_key: {
    description: "Send a trusted browser key press or combination through Chrome DevTools Protocol (e.g., Enter, Tab, Ctrl+A, Meta+Shift+P)",
    schema: z.object({
      key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'a', 'ArrowDown', 'Escape')"),
      modifiers: z.object({
        ctrl: z.boolean().default(false),
        alt: z.boolean().default(false),
        shift: z.boolean().default(false),
        meta: z.boolean().default(false),
      }).optional().describe("Modifier keys to hold during keypress"),
      selector: z.string().optional().describe("CSS selector of target element (defaults to active element)"),
      repeat: z.number().int().min(1).max(100).default(1).describe("Number of times to press"),
      delay: z.number().int().min(0).max(1000).default(50).describe("Delay between repeat presses in ms"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  type_text: {
    description: "Insert trusted text through Chrome DevTools Protocol, optionally character by character with a delay; this does not synthesize keydown or keyup events",
    schema: z.object({
      text: z.string().max(1000).describe("Text to type"),
      selector: z.string().optional().describe("CSS selector of target element (defaults to active/focused element)"),
      delayPerChar: z.number().int().min(0).max(100).default(50).describe("Delay between characters in ms"),
      clearFirst: z.boolean().default(false).describe("Clear the field before typing"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  dispatch_event: {
    description: "Fire an arbitrary DOM event on an element. Supports MouseEvent, KeyboardEvent, FocusEvent, InputEvent, CustomEvent, and more.",
    schema: z.object({
      selector: z.string().describe("CSS selector of target element"),
      eventType: z.string().describe("Event constructor name (e.g., 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'FocusEvent', 'InputEvent', 'TouchEvent', 'WheelEvent', 'PointerEvent')"),
      eventName: z.string().describe("Event name (e.g., 'click', 'mousedown', 'keydown', 'focus', 'input', 'touchstart', 'pointerdown')"),
      eventInit: z.record(z.unknown()).optional().describe("Event initialization properties (e.g., { bubbles: true, detail: { ... } })"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  drag_and_drop: {
    description: "Simulate drag and drop between two elements or coordinates. Dispatches the full sequence: mousedown, dragstart, drag, dragenter, dragover, drop, dragend, mouseup.",
    schema: z.object({
      sourceSelector: z.string().describe("CSS selector of element to drag"),
      targetSelector: z.string().min(1).optional().describe("CSS selector of drop target"),
      targetCoordinates: z.object({ x: z.number(), y: z.number() }).optional()
        .describe("Drop target coordinates (if no targetSelector)"),
      steps: z.number().int().min(1).max(100).default(10).describe("Number of intermediate mousemove events during drag"),
      tabId: z.number().describe("Tab ID (required)"),
    }).refine(data => data.targetSelector !== undefined || data.targetCoordinates !== undefined, {
      message: "Provide targetSelector or targetCoordinates",
      path: ["targetSelector"],
    }),
  },
  upload_file: {
    description: "Simulate file upload by setting files on a file input element. Creates File objects from provided data.",
    schema: z.object({
      selector: z.string().describe("CSS selector of file input element"),
      files: z.array(z.object({
        name: z.string().describe("File name"),
        content: z.string().describe("File content (base64 encoded for binary, plain text for text files)"),
        type: z.string().default("application/octet-stream").describe("MIME type"),
        isBase64: z.boolean().default(false).describe("Whether content is base64 encoded"),
      })).describe("Files to upload"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
} as const;

// ─── Browser API Control Tools ──────────────────────────────────────
export const browserApiTools = {
  set_geolocation: {
    description: "Override the browser's geolocation API to return specified coordinates",
    schema: z.object({
      latitude: z.number().min(-90).max(90).describe("Latitude"),
      longitude: z.number().min(-180).max(180).describe("Longitude"),
      accuracy: z.number().default(100).describe("Accuracy in meters"),
      altitude: z.number().optional(),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  clear_geolocation: {
    description: "Remove geolocation override, restoring normal behavior",
    schema: z.object({
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  emulate_media: {
    description: "Override CSS media features; omit all override fields to reset them",
    schema: z.object({
      colorScheme: z.enum(["light", "dark", "no-preference"]).optional()
        .describe("prefers-color-scheme"),
      reducedMotion: z.enum(["reduce", "no-preference"]).optional()
        .describe("prefers-reduced-motion"),
      forcedColors: z.enum(["active", "none"]).optional()
        .describe("forced-colors"),
      prefersContrast: z.enum(["more", "less", "no-preference"]).optional()
        .describe("prefers-contrast"),
      mediaType: z.enum(["screen", "print"]).optional()
        .describe("CSS media type override"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  set_device_metrics: {
    description: "Override device metrics and user agent; omit all override fields to reset them",
    schema: z.object({
      userAgent: z.string().optional().describe("User agent string override"),
      width: z.number().optional().describe("Viewport width"),
      height: z.number().optional().describe("Viewport height"),
      deviceScaleFactor: z.number().optional().describe("Device pixel ratio"),
      mobile: z.boolean().optional().describe("Emulate mobile device"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  get_accessibility_tree: {
    description: "Get a DOM-derived accessibility summary (roles, names, and ARIA states)",
    schema: z.object({
      selector: z.string().optional().describe("CSS selector to scope (defaults to entire page)"),
      maxDepth: z.number().int().min(0).max(32).default(8).describe("Maximum depth to traverse"),
      includeHidden: z.boolean().default(false).describe("Include hidden/aria-hidden elements"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  manage_dialogs: {
    description: "Handle browser alert/confirm/prompt dialogs (auto-accept, auto-dismiss, or provide input)",
    schema: z.object({
      action: z.enum(["setup", "getHistory", "clear"]).describe("Setup auto-handling, get dialog history, or clear"),
      autoAccept: z.boolean().optional().describe("Auto-accept dialogs (for setup)"),
      promptText: z.string().optional().describe("Text to enter for prompt dialogs"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  query_iframe: {
    description: "Execute a query or action inside a same-origin iframe",
    schema: z.object({
      frameSelector: z.string().describe("CSS selector of the iframe element"),
      action: z.enum(["querySelector", "getContent", "click", "fill"]).describe("Action to perform"),
      params: z.record(z.unknown()).optional().describe("Action-specific parameters (selector, value, code, etc.)"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  query_shadow_dom: {
    description: "Pierce shadow DOM boundaries to interact with elements inside shadow roots",
    schema: z.object({
      hostSelector: z.string().describe("CSS selector for the shadow DOM host element"),
      innerSelector: z.string().describe("CSS selector within the shadow root"),
      action: z.enum(["query", "click", "fill", "getText", "getAttribute"]).describe("Action to perform"),
      value: z.string().optional().describe("Value for fill action or attribute name for getAttribute"),
      tabId: z.number().describe("Tab ID (required)"),
    }),
  },
  get_error_log: {
    description: "Get JavaScript errors and unhandled promise rejections captured on the page",
    schema: z.object({
      tabId: z.number().describe("Tab ID (required)"),
      since: z.number().optional().describe("Timestamp to filter from"),
      limit: z.number().int().min(1).max(5000).default(50),
    }),
  },
} as const;

// ─── Server Tools ───────────────────────────────────────────────────
export const serverTools = {
  ping: {
    description: "Test server connectivity. Returns 'pong' to confirm the MCP server is responding.",
    schema: z.object({}),
  },
  health_check: {
    description: "Full diagnostic health check. Tests server status, extension WebSocket connection, and performs a round-trip tool call to verify the entire pipeline is working.",
    schema: z.object({}),
  },
} as const;

export const serverOnlyToolNames = ["ping", "health_check"] as const;

// ─── All Tools Combined ─────────────────────────────────────────────
export const allTools = {
  ...serverTools,
  ...navigationTools,
  ...domReadingTools,
  ...domInteractionTools,
  ...screenshotTools,
  ...networkTools,
  ...storageTools,
  ...waitTools,
  ...jsTools,
  ...analysisTools,
  ...downloadTools,
  ...consoleTools,
  press_key: keyboardEventTools.press_key,
  type_text: keyboardEventTools.type_text,
  dispatch_event: keyboardEventTools.dispatch_event,
  drag_and_drop: keyboardEventTools.drag_and_drop,
  upload_file: keyboardEventTools.upload_file,
  ...browserApiTools,
} as const;

export type ToolName = keyof typeof allTools;
