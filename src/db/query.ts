/**
 * Thin query execution layer used by every tool.
 *
 * Responsibilities:
 *  - run parameterized queries against the shared pool
 *  - enforce per-call timeout (mssql `request.timeout`)
 *  - translate driver errors into structured McpToolError
 *  - never used for anything but SELECT / metadata / DMV reads (enforced
 *    by callers + sql-guard for the generic execute_select tool)
 */
import sql from "mssql";
import type { AppConfig } from "../config/index.js";
import { getPool } from "./pool.js";
import { McpToolError } from "../types/index.js";

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowsAffected: number[];
  durationMs: number;
  truncated: boolean;
}

export type SqlParams = Record<string, { type: sql.ISqlType | (() => sql.ISqlType); value: unknown }>;

/**
 * Executes a query with a bound row cap and timeout. A capped query streams
 * rows and cancels after the first extra row, so the driver never collects
 * an unbounded result set. This does not prevent expensive work before rows
 * are returned; the timeout remains the server-cost guard.
 */
export async function runQuery<T = Record<string, unknown>>(
  config: AppConfig,
  text: string,
  params: SqlParams = {},
  opts: { maxRows?: number; timeoutMs?: number } = {}
): Promise<QueryResult<T>> {
  const pool = await getPool(config);
  const request = pool.request();
  // `Request.timeout` exists at runtime in the `mssql` driver (per-request
  // override of the pool's default requestTimeout) but is missing from the
  // @types/mssql declaration used here, hence the cast.
  const timeoutMs = opts.timeoutMs ?? config.db.queryTimeoutMs;
  (request as unknown as { timeout: number }).timeout = timeoutMs;

  for (const [name, def] of Object.entries(params)) {
    const type = typeof def.type === "function" ? (def.type as () => sql.ISqlType)() : def.type;
    request.input(name, type, def.value as never);
  }

  const start = Date.now();
  try {
    if (opts.maxRows !== undefined) {
      const maxRows = opts.maxRows;
      request.stream = true;
      const streamed = await new Promise<{ rows: T[]; rowsAffected: number[]; truncated: boolean }>((resolve, reject) => {
        const rows: T[] = [];
        const rowsAffected: number[] = [];
        let truncated = false;
        let failure: Error | undefined;
        request.on("row", (row: T) => {
          if (rows.length < maxRows) rows.push(row);
          else if (!truncated) {
            truncated = true;
            request.cancel();
          }
        });
        request.on("rowsaffected", (count: number) => rowsAffected.push(count));
        request.on("error", (err: Error) => {
          if (!(truncated && (err as Error & { code?: string }).code === "ECANCEL")) failure ??= err;
        });
        request.on("done", () => {
          if (failure) reject(failure);
          else resolve({ rows, rowsAffected, truncated });
        });
        void request.query<T>(text).catch((err: Error) => {
          if (!(truncated && (err as Error & { code?: string }).code === "ECANCEL")) failure ??= err;
        });
      });
      return { ...streamed, durationMs: Date.now() - start };
    }
    const result = await request.query<T>(text);
    const durationMs = Date.now() - start;
    return { rows: (result.recordset as unknown as T[]) ?? [], rowsAffected: result.rowsAffected, durationMs, truncated: false };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(message)) {
      throw new McpToolError(
        "QUERY_TIMEOUT",
        `Query exceeded the configured ${timeoutMs} ms timeout.`,
        { durationMs }
      );
    }
    if (/permission|denied|grant/i.test(message)) {
      throw new McpToolError("PERMISSION_DENIED", "SQL Server denied this operation.");
    }
    throw new McpToolError("DATABASE_ERROR", "SQL Server could not complete the query.");
  }
}

export { sql };
