import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery, sql as mssql } from "../db/query.js";
import { assertSafeSelect } from "../security/sql-guard.js";
import { redactRows } from "../security/redaction.js";
import { clampMaxRows, noteRowLimitExceeded } from "../security/limits.js";

const paramValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const executeSelectInput = z.object({
  sql: z.string().min(1).max(20000).describe("A single read-only SELECT statement (optionally starting with WITH for a CTE)."),
  parameters: z.record(z.string(), paramValueSchema).optional().describe("Named parameters referenced in sql as @name."),
  maxRows: z.number().int().positive().max(100000).optional(),
});
export type ExecuteSelectInput = z.infer<typeof executeSelectInput>;

function inferSqlType(value: unknown): mssql.ISqlType {
  if (typeof value === "number") return Number.isInteger(value) ? mssql.Int() : mssql.Float();
  if (typeof value === "boolean") return mssql.Bit();
  return mssql.NVarChar(4000);
}

export async function executeSelect(config: AppConfig, input: ExecuteSelectInput) {
  const { normalizedSql } = assertSafeSelect(input.sql);
  const maxRows = clampMaxRows(input.maxRows, config);

  const params: Record<string, { type: mssql.ISqlType; value: unknown }> = {};
  for (const [name, value] of Object.entries(input.parameters ?? {})) {
    params[name] = { type: inferSqlType(value), value };
  }

  const result = await runQuery(config, normalizedSql, params, { maxRows });
  const rows = redactRows(result.rows as Record<string, unknown>[], config);

  return {
    rows,
    rowCount: rows.length,
    truncated: result.truncated,
    durationMs: result.durationMs,
    limitNote: noteRowLimitExceeded(rows.length, maxRows),
  };
}
