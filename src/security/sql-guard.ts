/**
 * SQL safety guard for the `sqlserver.execute_select` tool.
 *
 * IMPORTANT (spec §8/§20): this guard is defense-in-depth, NOT the primary
 * security boundary. The primary boundary is the SQL Server account itself
 * (see sql/create-review-user.sql), which is physically unable to write.
 * This guard exists to fail fast with a clear error and an audit trail
 * before a request ever reaches the server, and to stop obviously
 * dangerous statements (multiple batches, EXEC, xp_/sp_ procs, DDL/DML).
 *
 * Design notes:
 *  - We tokenize rather than regex-match the raw SQL, specifically to
 *    avoid keywords hidden inside string literals or comments causing
 *    false positives, and to avoid comments/whitespace/case tricks
 *    causing false negatives.
 *  - We build a "masked" version of the SQL where every string literal
 *    and every comment is replaced with a fixed-width neutral placeholder.
 *    All keyword/structural checks run against the masked text, so
 *    content inside quotes or comments can never influence the outcome.
 */
import { McpToolError } from "../types/index.js";

const BANNED_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "DENY",
  "BACKUP",
  "RESTORE",
  "DBCC",
  "SHUTDOWN",
  "EXEC",
  "EXECUTE",
];

// sp_configure, xp_cmdshell, and any sp_/xp_/xp2_ extended/system proc call.
const BANNED_PROC_PREFIX = /\b(sp_|xp_)\w*/i;

interface MaskResult {
  masked: string; // same length-ish text, literals/comments blanked to spaces, uppercase keywords preserved case
  original: string;
}

/**
 * Replaces every string literal ('...', with '' escaping) and every
 * comment (--... and /* ... *\/) with spaces of the same length, so
 * position-sensitive checks (like top-level semicolon splitting) still
 * line up with the original text.
 */
function maskLiteralsAndComments(input: string): MaskResult {
  let out = "";
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    const next = input[i + 1];

    // Line comment
    if (ch === "-" && next === "-") {
      let j = i;
      while (j < n && input[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n - 1 && !(input[j] === "*" && input[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    // String literal '...'
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (input[j] === "'" && input[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (input[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    // Bracketed identifier [ ... ] - keep as-is (not a literal, but also
    // not something we scan keywords inside of; harmless either way).
    out += ch;
    i++;
  }

  return { masked: out, original: input };
}

function topLevelStatements(masked: string): string[] {
  // Split on semicolons that are not inside parentheses.
  const statements: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of masked) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      statements.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

function tokens(masked: string): string[] {
  return masked.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
}

export interface GuardResult {
  ok: true;
  normalizedSql: string;
}

/**
 * Validates that `sql` is a single, read-only SELECT (optionally preceded
 * by one or more CTEs via WITH). Throws McpToolError("UNSAFE_QUERY", ...)
 * otherwise.
 */
export function assertSafeSelect(rawSql: string): GuardResult {
  if (typeof rawSql !== "string" || rawSql.trim().length === 0) {
    throw new McpToolError("INVALID_INPUT", "sql must be a non-empty string.");
  }

  const { masked } = maskLiteralsAndComments(rawSql);

  const statements = topLevelStatements(masked);
  if (statements.length === 0) {
    throw new McpToolError("INVALID_INPUT", "sql must contain a statement.");
  }
  if (statements.length > 1) {
    throw new McpToolError(
      "UNSAFE_QUERY",
      "Multiple SQL batches/statements are not permitted. Submit exactly one SELECT statement."
    );
  }

  const statement = statements[0]!;
  const upperTokens = tokens(statement).map((t) => t.toUpperCase());

  if (upperTokens.length === 0) {
    throw new McpToolError("INVALID_INPUT", "sql must contain a statement.");
  }

  const first = upperTokens[0];
  if (first !== "SELECT" && first !== "WITH") {
    throw new McpToolError(
      "UNSAFE_QUERY",
      `Only SELECT statements (optionally starting with WITH for a CTE) are permitted. Statement began with '${first}'.`
    );
  }

  // If it starts with WITH, the CTE chain must eventually lead to a SELECT
  // as the final top-level clause, and must not contain INSERT/UPDATE/DELETE
  // after the CTE definitions (WITH x AS (...) DELETE ... is banned).
  for (const kw of BANNED_KEYWORDS) {
    if (upperTokens.includes(kw)) {
      throw new McpToolError(
        "UNSAFE_QUERY",
        `Statement contains disallowed keyword '${kw}'. Only read-only SELECT queries are permitted.`
      );
    }
  }

  if (BANNED_PROC_PREFIX.test(statement)) {
    throw new McpToolError(
      "UNSAFE_QUERY",
      "Calls to system/extended stored procedures (sp_*, xp_*) are not permitted."
    );
  }

  // SELECT ... INTO <table> creates a table - disallow.
  if (/\bSELECT\b[\s\S]*?\bINTO\b/i.test(statement) && !/\bINTO\b\s*@/i.test(statement)) {
    // INTO followed by a variable (INTO @var) is a valid part of some
    // OUTPUT clauses in other engines, but in T-SQL SELECT...INTO always
    // creates a table when the target is not a variable. We conservatively
    // reject unless the target is a declared @variable (not usable in a
    // read-only, no-declare context anyway since DECLARE is not banned
    // explicitly but variables require it).
    throw new McpToolError(
      "UNSAFE_QUERY",
      "SELECT ... INTO is not permitted because it creates a table."
    );
  }

  // Disallow OPENROWSET/OPENDATASOURCE/OPENQUERY which can execute remote
  // commands or bypass intent.
  if (/\bOPEN(ROWSET|DATASOURCE|QUERY)\b/i.test(statement)) {
    throw new McpToolError(
      "UNSAFE_QUERY",
      "OPENROWSET/OPENDATASOURCE/OPENQUERY are not permitted."
    );
  }

  return { ok: true, normalizedSql: rawSql.trim() };
}
