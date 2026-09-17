import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery, sql } from "../db/query.js";
import type { CapabilityFlags } from "../types/index.js";
import { McpToolError } from "../types/index.js";
import { clampMaxRows } from "../security/limits.js";
import { truncateText } from "../security/limits.js";

export const queryStoreTopQueriesInput = z.object({
  lookbackHours: z.number().positive().max(24 * 30).optional().default(24),
  orderBy: z.enum(["duration", "cpu", "logical_reads", "executions"]).optional().default("duration"),
  limit: z.number().int().positive().max(500).optional().default(20),
});
export type QueryStoreTopQueriesInput = z.infer<typeof queryStoreTopQueriesInput>;

function requireQueryStore(capabilities: CapabilityFlags) {
  if (!capabilities.queryStore) {
    throw new McpToolError(
      "QUERY_STORE_DISABLED",
      "Query Store is not enabled (or not accessible) on this database. Enable it with ALTER DATABASE ... SET QUERY_STORE = ON (requires a DBA)."
    );
  }
}

export async function queryStoreTopQueries(
  config: AppConfig,
  input: QueryStoreTopQueriesInput,
  capabilities: CapabilityFlags
) {
  requireQueryStore(capabilities);
  const limit = clampMaxRows(input.limit, config);
  const orderAlias: Record<QueryStoreTopQueriesInput["orderBy"], string> = {
    duration: "avgDurationMs",
    cpu: "avgCpuMs",
    logical_reads: "avgLogicalReads",
    executions: "countExecutions",
  };
  const orderColumn = orderAlias[input.orderBy];

  const { rows } = await runQuery<{
    queryId: number;
    planId: number;
    queryText: string;
    countExecutions: number;
    avgDurationMs: number;
    totalDurationMs: number;
    avgCpuMs: number;
    totalCpuMs: number;
    avgLogicalReads: number;
    lastExecutionTime: Date;
  }>(
    config,
    `
    DECLARE @since DATETIME2 = DATEADD(HOUR, -@lookbackHours, SYSUTCDATETIME());

    SELECT TOP (@limit)
      q.query_id AS queryId,
      p.plan_id AS planId,
      LEFT(qt.query_sql_text, 4000) AS queryText,
      SUM(rs.count_executions) AS countExecutions,
      SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS avgDurationMs,
      SUM(rs.avg_duration * rs.count_executions) / 1000.0 AS totalDurationMs,
      SUM(rs.avg_cpu_time * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS avgCpuMs,
      SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS totalCpuMs,
      SUM(rs.avg_logical_io_reads * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) AS avgLogicalReads,
      MAX(rs.last_execution_time) AS lastExecutionTime
    FROM sys.query_store_query q
    JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
    JOIN sys.query_store_plan p ON p.query_id = q.query_id
    JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
    JOIN sys.query_store_runtime_stats_interval rsi ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
    WHERE rsi.start_time >= @since
    GROUP BY q.query_id, p.plan_id, qt.query_sql_text
    ORDER BY ${orderColumn} DESC
    `,
    {
      lookbackHours: { type: sql.Float, value: input.lookbackHours },
      limit: { type: sql.Int, value: limit },
    },
    { maxRows: limit }
  );

  return {
    lookbackHours: input.lookbackHours,
    orderBy: input.orderBy,
    queries: rows,
  };
}

export const queryStoreQueryInput = z.object({
  queryId: z.number().int().positive(),
  historyLimit: z.number().int().positive().max(1000).optional().default(100),
});
export type QueryStoreQueryInput = z.infer<typeof queryStoreQueryInput>;

export async function queryStoreQuery(
  config: AppConfig,
  input: QueryStoreQueryInput,
  capabilities: CapabilityFlags
) {
  requireQueryStore(capabilities);

  const { rows: textRows } = await runQuery<{ queryText: string }>(
    config,
    `
    SELECT LEFT(qt.query_sql_text, @maxChars) AS queryText
    FROM sys.query_store_query q
    JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
    WHERE q.query_id = @queryId
    `,
    {
      queryId: { type: sql.Int, value: input.queryId },
      maxChars: { type: sql.Int, value: config.limits.maxQueryTextChars },
    }
  );

  if (textRows.length === 0) {
    return { queryId: input.queryId, found: false };
  }

  const historyLimit = clampMaxRows(input.historyLimit, config);

  const { rows: plans } = await runQuery<{
    planId: number;
    createdAt: Date;
    lastExecutionTime: Date;
    countExecutions: number;
    avgDurationMs: number;
    avgCpuMs: number;
    avgLogicalReads: number;
    isForcedPlan: boolean;
  }>(
    config,
    `
    SELECT TOP (@planLimit)
      p.plan_id AS planId,
      p.last_compile_start_time AS createdAt,
      MAX(rs.last_execution_time) AS lastExecutionTime,
      SUM(rs.count_executions) AS countExecutions,
      SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS avgDurationMs,
      SUM(rs.avg_cpu_time * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS avgCpuMs,
      SUM(rs.avg_logical_io_reads * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) AS avgLogicalReads,
      p.is_forced_plan AS isForcedPlan
    FROM sys.query_store_plan p
    JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
    WHERE p.query_id = @queryId
    GROUP BY p.plan_id, p.last_compile_start_time, p.is_forced_plan
    ORDER BY lastExecutionTime DESC
    `,
    {
      queryId: { type: sql.Int, value: input.queryId },
      planLimit: { type: sql.Int, value: config.limits.maxRows + 1 },
    },
    { maxRows: config.limits.maxRows + 1 }
  );

  const { rows: historyRows } = await runQuery<{
    planId: number;
    intervalStart: Date;
    intervalEnd: Date;
    executionCount: number;
    avgDurationMs: number;
    avgCpuMs: number;
    avgLogicalReads: number;
    firstExecutionTime: Date;
    lastExecutionTime: Date;
  }>(
    config,
    `
    SELECT TOP (@historyLimit)
      p.plan_id AS planId,
      rsi.start_time AS intervalStart,
      rsi.end_time AS intervalEnd,
      SUM(rs.count_executions) AS executionCount,
      SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS avgDurationMs,
      SUM(rs.avg_cpu_time * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS avgCpuMs,
      SUM(rs.avg_logical_io_reads * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) AS avgLogicalReads,
      MIN(rs.first_execution_time) AS firstExecutionTime,
      MAX(rs.last_execution_time) AS lastExecutionTime
    FROM sys.query_store_plan p
    JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
    JOIN sys.query_store_runtime_stats_interval rsi ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
    WHERE p.query_id = @queryId
    GROUP BY p.plan_id, rsi.runtime_stats_interval_id, rsi.start_time, rsi.end_time
    ORDER BY intervalStart DESC, planId DESC
    `,
    {
      queryId: { type: sql.Int, value: input.queryId },
      historyLimit: { type: sql.Int, value: historyLimit + 1 },
    },
    { maxRows: historyLimit + 1 }
  );

  const { text, truncated } = truncateText(textRows[0]?.queryText ?? "", config.limits.maxQueryTextChars);

  return {
    queryId: input.queryId,
    found: true,
    queryText: text,
    queryTextTruncated: truncated,
    planCount: plans.length > config.limits.maxRows ? `>${config.limits.maxRows}` : plans.length,
    plans: plans.slice(0, config.limits.maxRows),
    plansTruncated: plans.length > config.limits.maxRows,
    runtimeHistory: historyRows.slice(0, historyLimit),
    runtimeHistoryTruncated: historyRows.length > historyLimit,
    note:
      plans.length > 1
        ? "Multiple plans found for this query — this often indicates a plan regression or parameter sniffing issue. Compare avgDurationMs/avgLogicalReads across plans."
        : undefined,
  };
}
