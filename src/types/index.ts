/**
 * Shared types used across the SQL Server Review MCP.
 */

export type ErrorCode =
  | "INVALID_INPUT"
  | "UNSAFE_QUERY"
  | "PERMISSION_DENIED"
  | "QUERY_TIMEOUT"
  | "ROW_LIMIT_EXCEEDED"
  | "QUERY_STORE_DISABLED"
  | "FEATURE_UNAVAILABLE"
  | "DATABASE_ERROR"
  | "CONNECTION_ERROR";

/** Structured error shape returned to MCP clients. Never contains secrets. */
export class McpToolError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export interface CapabilityFlags {
  queryStore: boolean;
  waitStats: boolean;
  missingIndexDmv: boolean;
  viewServerState: boolean;
  viewDefinition: boolean;
  ioStats: boolean;
  blockingInfo: boolean;
  reason?: Record<string, string>;
}

export interface AuditLogEntry {
  timestamp: string;
  tool: string;
  database?: string;
  durationMs: number;
  rowsReturned?: number;
  success: boolean;
  errorCode?: string;
  fingerprint?: string;
}
