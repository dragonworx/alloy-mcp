type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatMessage(level: LogLevel, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (data !== undefined) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

function writeLog(level: LogLevel, msg: string, data?: unknown) {
  if (!shouldLog(level)) return;

  const formattedMsg = formatMessage(level, msg, data);

  // Write to console (stderr to not interfere with MCP stdio)
  console.error(formattedMsg);
}

export const logger = {
  debug(msg: string, data?: unknown) {
    writeLog("debug", msg, data);
  },
  info(msg: string, data?: unknown) {
    writeLog("info", msg, data);
  },
  warn(msg: string, data?: unknown) {
    writeLog("warn", msg, data);
  },
  error(msg: string, data?: unknown) {
    writeLog("error", msg, data);
  },
};
