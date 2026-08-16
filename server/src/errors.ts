export enum ErrorCode {
  EXTENSION_NOT_CONNECTED = 1000,
  CONNECTION_LOST = 1001,
  INVALID_TOOL = 1100,
  INVALID_PARAMS = 1101,
  REQUEST_TIMEOUT = 1103,
  INTERNAL_ERROR = 9999,
}

export class MCPError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "MCPError";
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export function errorResponse(code: ErrorCode, message: string, details?: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ code, message, details }),
      },
    ],
  };
}
