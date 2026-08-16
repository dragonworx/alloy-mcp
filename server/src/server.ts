import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";
import { loadPairingToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { WebSocketBridge } from "./websocket.js";
import { handleToolCall } from "./handlers.js";
import { logger, setLogLevel } from "./logger.js";
import { allTools } from "./tools.js";
import { DualStdioTransport } from "./stdio-transport.js";

const config = loadConfig();
setLogLevel(config.logging.level);

// Create WebSocket bridge to Chrome extension
const bridge = new WebSocketBridge(config, loadPairingToken());
let bridgeStopped = false;

function stopBridge(): void {
  if (bridgeStopped) return;
  bridgeStopped = true;
  bridge.stop();
}

// Create MCP server
const mcp = new McpServer({
  name: "alloy",
  version: "1.0.0",
});

// Register all tools
for (const [name, tool] of Object.entries(allTools)) {
  const registeredTool = tool as {
    description: string;
    schema: ZodTypeAny;
  };
  mcp.registerTool(
    name,
    {
      description: registeredTool.description,
      inputSchema: registeredTool.schema,
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      logger.info(`Tool called: ${name}`);
      const result = await handleToolCall(bridge, name, args, config.security.outputDirectory);
      logger.debug(`Tool completed: ${name}`);
      return result;
    }
  );
}

// Provide tool names to bridge for handshake validation
bridge.setServerToolNames(Object.keys(allTools));

// Start WebSocket server for extension communication
bridge.start();

// Connect MCP via stdio with protocol logging
const rawTransport = new DualStdioTransport();
const transport = new Proxy(rawTransport, {
  get(target, prop, receiver) {
    if (prop === "send") {
      return async (message: JSONRPCMessage) => {
        const msg = message as any;
        if (msg.id !== undefined && msg.result) {
          // This is a response to a request
          if (msg.result?.tools) {
            logger.info(`[STDIO OUT] tools/list response: ${msg.result.tools.length} tools`);
            // Log first tool as sample
            if (msg.result.tools.length > 0) {
              const t = msg.result.tools[0];
              logger.info(`[STDIO OUT] Sample tool: ${JSON.stringify({ name: t.name, hasDescription: !!t.description, hasInputSchema: !!t.inputSchema, schemaType: t.inputSchema?.type })}`);
            }
          } else {
            const keys = Object.keys(msg.result || {}).join(",");
            logger.info(`[STDIO OUT] Response id=${msg.id} keys=[${keys}]`);
          }
        } else if (msg.method) {
          logger.info(`[STDIO OUT] Notification method=${msg.method}`);
        } else if (msg.error) {
          logger.error(`[STDIO OUT] Error id=${msg.id} code=${msg.error.code} message=${msg.error.message}`);
        }
        return target.send(message);
      };
    }
    const value = Reflect.get(target, prop, receiver);
    if (prop === "onmessage") return value;
    if (typeof value === "function") return value.bind(target);
    return value;
  },
  set(target, prop, value) {
    if (prop === "onclose" && typeof value === "function") {
      const originalHandler = value;
      (target as any).onclose = () => {
        stopBridge();
        return originalHandler();
      };
      return true;
    }
    if (prop === "onmessage" && typeof value === "function") {
      const origHandler = value;
      (target as any).onmessage = (message: JSONRPCMessage) => {
        const msg = message as any;
        if (msg.method) {
          logger.info(`[STDIO IN] id=${msg.id ?? "notification"} method=${msg.method}`);
        } else {
          logger.info("[STDIO IN] Response received");
        }
        return origHandler(message);
      };
      return true;
    }
    if (prop === "onerror" && typeof value === "function") {
      const origHandler = value;
      (target as any).onerror = (error: Error) => {
        logger.error(`[STDIO ERROR] ${error.message}`, error.stack);
        return origHandler(error);
      };
      return true;
    }
    (target as any)[prop] = value;
    return true;
  },
});

logger.info("Waiting for Claude Code MCP connection via stdio...");
await mcp.connect(transport as unknown as DualStdioTransport);

logger.info("✓ Claude Code connected to MCP server via stdio");
logger.info("Alloy MCP Server started");
logger.info(`WebSocket: ws://${config.websocket.host}:${config.websocket.port}`);
logger.info(`Tools registered: ${Object.keys(allTools).length}`);

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down...");
  stopBridge();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Shutting down...");
  stopBridge();
  process.exit(0);
});
