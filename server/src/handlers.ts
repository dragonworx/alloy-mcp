import { z, type ZodObject, type ZodRawShape } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { allTools, type ToolName } from "./tools.js";
import { BridgeRequestError, WebSocketBridge, type ToolResponse } from "./websocket.js";
import { ErrorCode, errorResponse } from "./errors.js";
import { logger } from "./logger.js";
import { writeOutputFile } from "./paths.js";

// ─── Parameter Type Coercion for AI Agent Compatibility ────────────
function unwrapSchemaField(field: z.ZodTypeAny): z.ZodTypeAny {
  if (field instanceof z.ZodOptional) return unwrapSchemaField(field._def.innerType);
  if (field instanceof z.ZodDefault) return unwrapSchemaField(field._def.innerType);
  return field;
}

function coerceNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.toLowerCase();
  const values = new Map<string, boolean>([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ]);
  return values.get(normalized) ?? value;
}

function coerceParameterValue(value: unknown, field: z.ZodTypeAny): unknown {
  const innerType = unwrapSchemaField(field);
  if (innerType instanceof z.ZodNumber) return coerceNumber(value);
  if (innerType instanceof z.ZodBoolean) return coerceBoolean(value);
  return value;
}

function unwrapObjectSchema(schema: z.ZodTypeAny): ZodObject<ZodRawShape> {
  if (schema instanceof z.ZodEffects) return unwrapObjectSchema(schema._def.schema);
  if (schema instanceof z.ZodObject) return schema;
  throw new Error("Tool schema must resolve to an object");
}

function coerceParameterTypes(args: Record<string, unknown>, schema: z.ZodTypeAny): Record<string, unknown> {
  const objectSchema = unwrapObjectSchema(schema);
  const coerced = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const field = objectSchema.shape[key] as z.ZodTypeAny | undefined;
    if (value == null || !field) continue;
    coerced[key] = coerceParameterValue(value, field);
  }
  return coerced;
}

function pingResult(bridge: WebSocketBridge): CallToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "pong",
        server: "online",
        extensionConnected: bridge.isConnected,
        extensionVersion: bridge.extensionVersion,
        timestamp: Date.now(),
      }, null, 2),
    }],
  };
}

async function healthCheckResult(bridge: WebSocketBridge): Promise<CallToolResult> {
  const checks: Record<string, unknown> = {
    server: "online",
    extensionConnected: bridge.isConnected,
    extensionVersion: bridge.extensionVersion,
    extensionCapabilities: bridge.extensionCapabilities.length,
    timestamp: Date.now(),
  };

  if (bridge.isConnected) {
    const start = Date.now();
    try {
      const response = await bridge.sendToolRequest("list_tabs", { activeOnly: true });
      checks.roundTrip = {
        success: !response.error,
        latencyMs: Date.now() - start,
        error: response.error?.message,
      };
    } catch (error) {
      checks.roundTrip = {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  return { content: [{ type: "text", text: JSON.stringify(checks, null, 2) }] };
}

async function handleServerTool(bridge: WebSocketBridge, toolName: string): Promise<CallToolResult | null> {
  if (toolName === "ping") return pingResult(bridge);
  if (toolName === "health_check") return healthCheckResult(bridge);
  return null;
}

type ExtensionRequestOutcome =
  | { ok: true; response: ToolResponse }
  | { ok: false; result: CallToolResult };

function bridgeFailureCode(reason: BridgeRequestError["reason"]): ErrorCode {
  if (reason === "timeout") return ErrorCode.REQUEST_TIMEOUT;
  if (reason === "not_connected") return ErrorCode.EXTENSION_NOT_CONNECTED;
  return ErrorCode.CONNECTION_LOST;
}

async function requestExtensionTool(
  bridge: WebSocketBridge,
  toolName: string,
  params: Record<string, unknown>
): Promise<ExtensionRequestOutcome> {
  try {
    return { ok: true, response: await bridge.sendToolRequest(toolName, params) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(`Tool execution failed: ${toolName}`, message);
    if (!(error instanceof BridgeRequestError)) {
      return { ok: false, result: errorResponse(ErrorCode.INTERNAL_ERROR, message) };
    }
    return { ok: false, result: errorResponse(bridgeFailureCode(error.reason), message) };
  }
}

function normalizeImageData(image: string): string {
  if (!image.startsWith("data:")) return image;
  const separator = image.indexOf(",");
  if (separator < 0) throw new Error("Invalid screenshot data URI");
  return image.slice(separator + 1);
}

function formatScreenshotResponse(
  toolName: string,
  params: Record<string, unknown>,
  responseResult: unknown,
  outputDirectory: string
): CallToolResult | null {
  if (toolName !== "take_screenshot" && toolName !== "capture_element") return null;
  if (!responseResult || typeof responseResult !== "object") return null;

  const result = responseResult as Record<string, unknown>;
  if (typeof result.image !== "string") return null;

  try {
    const imageData = normalizeImageData(result.image);
    if (typeof params.filePath === "string") {
      const buffer = Buffer.from(imageData, "base64");
      const filePath = writeOutputFile(outputDirectory, params.filePath, buffer);
      logger.info("Screenshot saved to output directory");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            savedTo: filePath,
            dimensions: result.dimensions,
            format: result.format,
            size: buffer.length,
          }, null, 2),
        }],
      };
    }
    return {
      content: [
        { type: "image", data: imageData, mimeType: (result.mimeType as string) || "image/png" },
        { type: "text", text: JSON.stringify({ dimensions: result.dimensions, format: result.format }) },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process screenshot";
    logger.error(`Failed to process screenshot: ${message}`);
    return errorResponse(ErrorCode.INTERNAL_ERROR, `Failed to process screenshot: ${message}`);
  }
}

export async function handleToolCall(
  bridge: WebSocketBridge,
  toolName: string,
  args: Record<string, unknown>,
  outputDirectory = process.cwd()
): Promise<CallToolResult> {
  // Validate tool exists
  if (!(toolName in allTools)) {
    return errorResponse(ErrorCode.INVALID_TOOL, `Unknown tool: ${toolName}`);
  }

  const tool = allTools[toolName as ToolName];

  // Coerce parameter types for AI agent compatibility
  const coercedArgs = coerceParameterTypes(args, tool.schema);

  // Validate parameters
  const parsed = tool.schema.safeParse(coercedArgs);
  if (!parsed.success) {
    return errorResponse(ErrorCode.INVALID_PARAMS,
      `Invalid parameters for tool ${toolName}. Common issues:
      - tabId must be a number (got ${typeof args.tabId})
      - Boolean flags like 'active' should be true/false, not strings
      - Ensure required parameters are provided`,
      parsed.error.format());
  }

  const parsedData = parsed.data as Record<string, unknown>;

  logger.debug(`Tool call: ${toolName}, bridge connected: ${bridge.isConnected}`);
  const serverResult = await handleServerTool(bridge, toolName);
  if (serverResult) return serverResult;
  if (!bridge.isConnected) {
    logger.warn(`Tool ${toolName} blocked: extension not connected`);
    return errorResponse(
      ErrorCode.EXTENSION_NOT_CONNECTED,
      "Chrome extension is not connected. Please ensure the extension is installed and the browser is open."
    );
  }

  const outcome = await requestExtensionTool(bridge, toolName, parsedData);
  if (!outcome.ok) return outcome.result;
  const { response } = outcome;

  // Handle error from extension
  if (response.error) {
    return errorResponse(response.error.code as ErrorCode, response.error.message, response.error.details);
  }

  const screenshotResult = formatScreenshotResponse(toolName, parsedData, response.result, outputDirectory);
  if (screenshotResult) return screenshotResult;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(response.result, null, 2),
      },
    ],
  };
}

