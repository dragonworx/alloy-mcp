import { resolve } from "node:path";

export interface ServerConfig {
  websocket: {
    port: number;
    host: string;
    maxConnections: number;
  };
  timeouts: {
    toolExecution: number;
    screenshot: number;
    pageLoad: number;
    elementWait: number;
  };
  limits: {
    maxScreenshotDimension: number;
    maxScreenshotPayloadBytes: number;
    maxNetworkLogEntries: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  security: {
    outputDirectory: string;
  };
}

export const defaultConfig: ServerConfig = {
  websocket: {
    port: 3001,
    host: "localhost",
    maxConnections: 1,
  },
  timeouts: {
    toolExecution: 30_000,
    screenshot: 60_000,
    pageLoad: 30_000,
    elementWait: 30_000,
  },
  limits: {
    maxScreenshotDimension: 4096,
    maxScreenshotPayloadBytes: 24 * 1_048_576,
    maxNetworkLogEntries: 1000,
  },
  logging: {
    level: "info",
  },
  security: {
    outputDirectory: resolve(process.env.CHROME_MCP_OUTPUT_DIR || "artifacts"),
  },
};

export function loadConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    ...defaultConfig,
    ...overrides,
    websocket: { ...defaultConfig.websocket, ...overrides?.websocket },
    timeouts: { ...defaultConfig.timeouts, ...overrides?.timeouts },
    limits: { ...defaultConfig.limits, ...overrides?.limits },
    logging: { ...defaultConfig.logging, ...overrides?.logging },
    security: { ...defaultConfig.security, ...overrides?.security },
  };
}
