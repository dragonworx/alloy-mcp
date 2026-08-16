(() => {
  if (window.__mcpErrorLog) return;

  window.__mcpErrorLog = [];

  function record(entry) {
    window.__mcpErrorLog.push({ ...entry, timestamp: Date.now() });
    if (window.__mcpErrorLog.length > 200) {
      window.__mcpErrorLog = window.__mcpErrorLog.slice(-200);
    }
  }

  window.addEventListener("error", event => {
    record({
      type: "error",
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error?.stack,
    });
  });

  window.addEventListener("unhandledrejection", event => {
    record({
      type: "unhandledRejection",
      reason: String(event.reason),
      stack: event.reason?.stack,
    });
  });
})();