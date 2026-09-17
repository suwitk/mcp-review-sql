import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { getPool } from "../db/pool.js";
import { assertSafeSelect } from "../security/sql-guard.js";
import { McpToolError } from "../types/index.js";
import { truncateText } from "../security/limits.js";

const paramValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const getEstimatedPlanInput = z.object({
  sql: z.string().min(1).max(20000),
  parameters: z.record(z.string(), paramValueSchema).optional(),
  includeRawXml: z.boolean().optional().default(false),
});
export type GetEstimatedPlanInput = z.infer<typeof getEstimatedPlanInput>;

interface Operator {
  type: string;
  object?: string;
  estimatedRows?: number;
  estimatedCost?: number;
  estimatedIo?: number;
  estimatedCpu?: number;
}

/**
 * Minimal, dependency-free XML attribute extraction. We deliberately avoid
 * a full XML DOM parser dependency for V1 and instead pull the handful of
 * attributes we need with targeted regexes. This is resilient to attribute
 * ordering but not a general-purpose XML parser.
 */
function extractOperators(xml: string): Operator[] {
  const ops: Operator[] = [];
  const relOpRegex = /<RelOp\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = relOpRegex.exec(xml))) {
    const tag = match[0];
    const physicalOp = /PhysicalOp="([^"]*)"/.exec(tag)?.[1];
    const estRows = /EstimateRows="([^"]*)"/.exec(tag)?.[1];
    const estCost = /EstimatedTotalSubtreeCost="([^"]*)"/.exec(tag)?.[1];
    const estIo = /EstimateIO="([^"]*)"/.exec(tag)?.[1];
    const estCpu = /EstimateCPU="([^"]*)"/.exec(tag)?.[1];

    // Look ahead a bounded window for the nearest Object element reference.
    const windowEnd = xml.indexOf("</RelOp>", match.index);
    const window = xml.slice(match.index, windowEnd > 0 ? windowEnd : match.index + 2000);
    const objectMatch = /<Object\b[^>]*Table="([^"]*)"[^>]*(?:Schema="([^"]*)")?/.exec(window);
    const schemaMatch = /Schema="\[?([^"\]]*)\]?"/.exec(window);
    const tableMatch = /Table="\[?([^"\]]*)\]?"/.exec(window);

    ops.push({
      type: physicalOp ?? "Unknown",
      object: tableMatch ? `${schemaMatch?.[1] ?? ""}.${tableMatch[1]}`.replace(/^\./, "") : undefined,
      estimatedRows: estRows ? Number(estRows) : undefined,
      estimatedCost: estCost ? Number(estCost) : undefined,
      estimatedIo: estIo ? Number(estIo) : undefined,
      estimatedCpu: estCpu ? Number(estCpu) : undefined,
    });
  }
  return ops;
}

function detectWarnings(xml: string, operators: Operator[]): string[] {
  const warnings: string[] = [];

  if (/PlanAffectingConvert/i.test(xml) || /ConvertIssue/i.test(xml)) {
    warnings.push("Implicit conversion detected (PlanAffectingConvert) — this can prevent index usage.");
  }
  if (/NoJoinPredicate/i.test(xml)) {
    warnings.push("Join without a predicate detected (NoJoinPredicate) — likely a Cartesian product.");
  }
  if (/ColumnsWithNoStatistics/i.test(xml)) {
    warnings.push("Columns with no statistics were referenced — cardinality estimates may be unreliable.");
  }
  if (/<Warnings[^>]*SpillOccurred="1"/i.test(xml) || /SpillToTempDb/i.test(xml)) {
    warnings.push("Operator spilled to tempdb — memory grant was likely insufficient.");
  }
  if (/<MissingIndexes>/i.test(xml)) {
    warnings.push("SQL Server suggests a missing index for this query (see missing-index diagnostics tool).");
  }
  if (operators.some((o) => o.type === "Table Scan")) {
    warnings.push("Table Scan present — table may lack a useful index (heap scan).");
  }
  if (operators.some((o) => o.type === "Clustered Index Scan")) {
    warnings.push("Clustered Index Scan present — check whether a seek-friendly index exists for this predicate.");
  }
  if (operators.some((o) => o.type === "Sort" && (o.estimatedRows ?? 0) > 100000)) {
    warnings.push("Large Sort operator (>100k estimated rows) — potentially expensive; consider supporting index order.");
  }
  if (operators.some((o) => o.type === "Hash Match")) {
    warnings.push("Hash Match join present — fine for large sets, but verify it is not masking a missing index for a Nested Loops alternative.");
  }
  if (operators.some((o) => /Lookup/i.test(o.type))) {
    warnings.push("Key/RID Lookup present — a covering index could eliminate this extra lookup.");
  }
  if (
    operators.some(
      (o) => o.type === "Nested Loops" && (o.estimatedRows ?? 0) > 50000
    )
  ) {
    warnings.push("Nested Loops with a large estimated input — may indicate a missing or unused index on the inner side.");
  }

  return warnings;
}

export async function getEstimatedPlan(config: AppConfig, input: GetEstimatedPlanInput) {
  const { normalizedSql } = assertSafeSelect(input.sql);
  const pool = await getPool(config);
  const transaction = pool.transaction();
  await transaction.begin();
  const request = transaction.request();
  // See src/db/query.ts for why this needs a cast (missing from @types/mssql).
  (request as unknown as { timeout: number }).timeout = config.db.queryTimeoutMs;

  for (const [name, value] of Object.entries(input.parameters ?? {})) {
    request.input(name, value as never);
  }

  let xml: string | undefined;
  try {
    await request.query("SET SHOWPLAN_XML ON;");
    const result = await request.query(normalizedSql);
    xml = (result.recordset?.[0] as Record<string, unknown> | undefined)?.["Microsoft SQL Server 2005 XML Showplan"] as
      | string
      | undefined;
  } finally {
    try {
      const offRequest = transaction.request();
      await offRequest.query("SET SHOWPLAN_XML OFF;");
    } catch {
      // best effort
    }
    await transaction.rollback();
  }

  if (!xml) {
    throw new McpToolError("DATABASE_ERROR", "SQL Server did not return an execution plan for this statement.");
  }

  const operators = extractOperators(xml);
  const warnings = detectWarnings(xml, operators);
  const estimatedCost = operators.reduce((max, o) => Math.max(max, o.estimatedCost ?? 0), 0);

  const response: Record<string, unknown> = {
    estimatedCost,
    warnings,
    operators: operators.map((o) => ({
      type: o.type,
      object: o.object,
      estimatedRows: o.estimatedRows,
      estimatedCost: o.estimatedCost,
    })),
    note: "This is an ESTIMATED plan (SET SHOWPLAN_XML). The statement is not executed and no rows are read or modified.",
  };

  if (input.includeRawXml) {
    const { text, truncated } = truncateText(xml, config.limits.maxPlanXmlChars);
    response.rawPlanXml = text;
    response.rawPlanTruncated = truncated;
  }

  return response;
}
