/**
 * Column-based redaction for result sets (spec §16).
 *
 * Schema metadata tools may still report that a sensitive column exists
 * (name, type, nullability) — only VALUES from execute_select /
 * data-bearing tools are redacted.
 */
import type { AppConfig } from "../config/index.js";

const REDACTED = "***REDACTED***";

export function isSensitiveColumn(columnName: string, patterns: string[]): boolean {
  const lower = columnName.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/** Redacts matching columns in-place on a shallow-cloned array of row objects. */
export function redactRows(
  rows: Record<string, unknown>[],
  config: AppConfig
): Record<string, unknown>[] {
  const patterns = config.redaction.columnPatterns;
  if (patterns.length === 0 || rows.length === 0) return rows;

  const columns = Object.keys(rows[0] ?? {});
  const sensitiveColumns = columns.filter((c) => isSensitiveColumn(c, patterns));
  if (sensitiveColumns.length === 0) return rows;

  return rows.map((row) => {
    const clone = { ...row };
    for (const col of sensitiveColumns) {
      if (col in clone) clone[col] = REDACTED;
    }
    return clone;
  });
}
