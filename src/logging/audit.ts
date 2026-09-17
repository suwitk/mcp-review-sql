/**
 * Structured JSON logging + audit trail.
 *
 * Rules (spec §17/§18):
 *  - Never log passwords, tokens, connection strings, or sensitive returned records.
 *  - Every tool call produces one audit line.
 *  - For execute_select, log a fingerprint, never SQL text or result rows.
 */
import type { AppConfig } from "../config/index.js";
import type { AuditLogEntry } from "../types/index.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

let currentLevel: Level = "info";

export function setLogLevel(level: string) {
  if ((LEVELS as readonly string[]).includes(level)) {
    currentLevel = level as Level;
  }
}

function shouldLog(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);
}

function write(level: Level, payload: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({ level, timestamp: new Date().toISOString(), ...payload });
  // stdout is reserved for MCP stdio protocol frames; all logs go to stderr.
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (msg: string, extra: Record<string, unknown> = {}) => write("debug", { msg, ...extra }),
  info: (msg: string, extra: Record<string, unknown> = {}) => write("info", { msg, ...extra }),
  warn: (msg: string, extra: Record<string, unknown> = {}) => write("warn", { msg, ...extra }),
  error: (msg: string, extra: Record<string, unknown> = {}) => write("error", { msg, ...extra }),
};

/** Simple, stable fingerprint for a SQL statement (normalizes literals/whitespace). */
export function fingerprintSql(sql: string): string {
  const normalized = sql
    .replace(/'[^']*'/g, "?")
    .replace(/\b\d+\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `fp_${hash.toString(16)}`;
}

export function truncateSql(sql: string, maxChars: number): string {
  if (sql.length <= maxChars) return sql;
  return sql.slice(0, maxChars) + `... [truncated ${sql.length - maxChars} chars]`;
}

export class AuditLogger {
  constructor(private config: AppConfig) {}

  record(entry: AuditLogEntry) {
    if (!this.config.logging.auditEnabled) return;
    write("info", { audit: true, ...entry });
  }
}
