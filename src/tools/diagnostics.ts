import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery, sql } from "../db/query.js";
import type { CapabilityFlags } from "../types/index.js";
import { McpToolError } from "../types/index.js";
import { clampMaxRows } from "../security/limits.js";

const MISSING_INDEX_WARNING =
  "SQL Server missing-index DMVs are advisory signals only. They must not be converted directly into CREATE INDEX statements without workload and existing-index analysis. This MCP never creates indexes.";

export const getMissingIndexStatsInput = z.object({
  limit: z.number().int().positive().max(500).optional().default(50),
});
export type GetMissingIndexStatsInput = z.infer<typeof getMissingIndexStatsInput>;

export async function getMissingIndexStats(
  config: AppConfig,
  input: GetMissingIndexStatsInput,
  capabilities: CapabilityFlags
) {
  if (!capabilities.missingIndexDmv) {
    throw new McpToolError(
      "PERMISSION_DENIED",
      "VIEW SERVER STATE permission is required to read missing-index DMVs."
    );
  }
  const limit = clampMaxRows(input.limit, config);

  const { rows } = await runQuery<{
    table: string;
    equalityColumns: string | null;
    inequalityColumns: string | null;
    includedColumns: string | null;
    userSeeks: number;
    userScans: number;
    avgTotalUserCost: number;
    avgUserImpact: number;
    estimatedImpact: number;
  }>(
    config,
    `
    SELECT TOP (@limit)
      mid.statement AS table,
      mid.equality_columns AS equalityColumns,
      mid.inequality_columns AS inequalityColumns,
      mid.included_columns AS includedColumns,
      migs.user_seeks AS userSeeks,
      migs.user_scans AS userScans,
      migs.avg_total_user_cost AS avgTotalUserCost,
      migs.avg_user_impact AS avgUserImpact,
      (migs.user_seeks + migs.user_scans) * migs.avg_total_user_cost * (migs.avg_user_impact / 100.0) AS estimatedImpact
    FROM sys.dm_db_missing_index_details mid
    JOIN sys.dm_db_missing_index_groups mig ON mig.index_handle = mid.index_handle
    JOIN sys.dm_db_missing_index_group_stats migs ON migs.group_handle = mig.index_group_handle
    WHERE mid.database_id = DB_ID()
    ORDER BY estimatedImpact DESC
    `,
    { limit: { type: sql.Int, value: limit } },
    { maxRows: limit }
  );

  return { warning: MISSING_INDEX_WARNING, suggestions: rows };
}

export const getTableStatsInput = z.object({
  schema: z.string().min(1).max(128).default("dbo"),
  table: z.string().min(1).max(128),
});
export type GetTableStatsInput = z.infer<typeof getTableStatsInput>;

export async function getTableStats(config: AppConfig, input: GetTableStatsInput) {
  const { rows } = await runQuery<{
    statsName: string;
    lastUpdated: Date | null;
    rowsSampled: number | null;
    steps: number | null;
    columns: string;
  }>(
    config,
    `
    SELECT
      st.name AS statsName,
      sp.last_updated AS lastUpdated,
      sp.rows_sampled AS rowsSampled,
      sp.steps AS steps,
      STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY sc.stats_column_id) AS columns
    FROM sys.stats st
    JOIN sys.tables t ON t.object_id = st.object_id
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.stats_columns sc ON sc.object_id = st.object_id AND sc.stats_id = st.stats_id
    JOIN sys.columns c ON c.object_id = sc.object_id AND c.column_id = sc.column_id
    CROSS APPLY sys.dm_db_stats_properties(st.object_id, st.stats_id) sp
    WHERE s.name = @schema AND t.name = @table
    GROUP BY st.name, sp.last_updated, sp.rows_sampled, sp.steps
    ORDER BY st.name
    `,
    {
      schema: { type: sql.NVarChar(256), value: input.schema },
      table: { type: sql.NVarChar(256), value: input.table },
    }
  );

  return {
    schema: input.schema,
    table: input.table,
    statistics: rows,
    note: "lastUpdated shows staleness. Stale statistics after heavy writes can cause bad cardinality estimates and poor plan choices.",
  };
}

export const getDatabaseFilesInput = z.object({});

export async function getDatabaseFiles(config: AppConfig) {
  const { rows } = await runQuery<{
    fileName: string;
    type: string;
    sizeMb: number;
    maxSizeMb: number | null;
    growth: string;
    physicalName: string;
  }>(
    config,
    `
    SELECT
      name AS fileName,
      type_desc AS type,
      CAST(size / 128.0 AS DECIMAL(18,2)) AS sizeMb,
      CASE WHEN max_size = -1 THEN NULL ELSE CAST(max_size / 128.0 AS DECIMAL(18,2)) END AS maxSizeMb,
      CASE WHEN is_percent_growth = 1 THEN CAST(growth AS VARCHAR(20)) + '%' ELSE CAST(growth / 128.0 AS VARCHAR(20)) + ' MB' END AS growth,
      physical_name AS physicalName
    FROM sys.database_files
    `
  );
  return { files: rows };
}

export const getIoStatsInput = z.object({});

export async function getIoStats(config: AppConfig, capabilities: CapabilityFlags) {
  if (!capabilities.ioStats) {
    throw new McpToolError(
      "PERMISSION_DENIED",
      "VIEW SERVER STATE permission is required to read sys.dm_io_virtual_file_stats."
    );
  }
  const { rows } = await runQuery<{
    fileName: string;
    type: string;
    numReads: number;
    numWrites: number;
    ioStallReadMs: number;
    ioStallWriteMs: number;
    bytesRead: number;
    bytesWritten: number;
  }>(
    config,
    `
    SELECT
      mf.name AS fileName,
      mf.type_desc AS type,
      vfs.num_of_reads AS numReads,
      vfs.num_of_writes AS numWrites,
      vfs.io_stall_read_ms AS ioStallReadMs,
      vfs.io_stall_write_ms AS ioStallWriteMs,
      vfs.num_of_bytes_read AS bytesRead,
      vfs.num_of_bytes_written AS bytesWritten
    FROM sys.dm_io_virtual_file_stats(DB_ID(), NULL) vfs
    JOIN sys.master_files mf ON mf.database_id = vfs.database_id AND mf.file_id = vfs.file_id
    `
  );

  const files = rows.map((r) => ({
    ...r,
    avgReadStallMs: r.numReads > 0 ? r.ioStallReadMs / r.numReads : 0,
    avgWriteStallMs: r.numWrites > 0 ? r.ioStallWriteMs / r.numWrites : 0,
  }));

  return {
    files,
    note: "Cumulative since last restart. Average read/write stall > ~10-20ms on data files often indicates storage-layer pressure, but confirm against storage baseline before concluding.",
  };
}

export const getBlockingSummaryInput = z.object({});

export async function getBlockingSummary(config: AppConfig, capabilities: CapabilityFlags) {
  if (!capabilities.blockingInfo) {
    throw new McpToolError(
      "PERMISSION_DENIED",
      "VIEW SERVER STATE permission is required to read blocking information."
    );
  }
  const { rows } = await runQuery<{
    waitingSessionId: number;
    blockingSessionId: number;
    waitType: string;
    waitDurationMs: number;
    resourceDescription: string;
  }>(
    config,
    `
    SELECT
      wt.session_id AS waitingSessionId,
      wt.blocking_session_id AS blockingSessionId,
      wt.wait_type AS waitType,
      wt.wait_duration_ms AS waitDurationMs,
      wt.resource_description AS resourceDescription
    FROM sys.dm_os_waiting_tasks wt
    WHERE wt.blocking_session_id IS NOT NULL AND wt.blocking_session_id <> 0
    ORDER BY wt.wait_duration_ms DESC
    `
  );

  return {
    blockedSessions: rows,
    note: "Metadata-only snapshot. This tool never terminates sessions (no KILL) or alters running requests — that decision belongs to a DBA.",
  };
}

export const getActiveExpensiveQueriesInput = z.object({
  limit: z.number().int().positive().max(100).optional().default(20),
});
export type GetActiveExpensiveQueriesInput = z.infer<typeof getActiveExpensiveQueriesInput>;

export async function getActiveExpensiveQueries(
  config: AppConfig,
  input: GetActiveExpensiveQueriesInput,
  capabilities: CapabilityFlags
) {
  if (!capabilities.viewServerState) {
    throw new McpToolError(
      "PERMISSION_DENIED",
      "VIEW SERVER STATE permission is required to inspect active requests."
    );
  }
  const limit = clampMaxRows(input.limit, config);

  const { rows } = await runQuery<{
    sessionId: number;
    status: string;
    cpuTimeMs: number;
    logicalReads: number;
    elapsedMs: number;
    commandText: string | null;
    waitType: string | null;
  }>(
    config,
    `
    SELECT TOP (@limit)
      r.session_id AS sessionId,
      r.status AS status,
      r.cpu_time AS cpuTimeMs,
      r.logical_reads AS logicalReads,
      r.total_elapsed_time AS elapsedMs,
      LEFT(t.text, 2000) AS commandText,
      r.wait_type AS waitType
    FROM sys.dm_exec_requests r
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
    WHERE r.session_id <> @@SPID
    ORDER BY r.total_elapsed_time DESC
    `,
    { limit: { type: sql.Int, value: limit } },
    { maxRows: limit }
  );

  return {
    activeQueries: rows,
    note: "Metadata-only observation of currently executing requests. This tool never kills sessions or modifies running requests.",
  };
}
