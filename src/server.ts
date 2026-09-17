/**
 * MCP server wiring: registers every read-only tool, wraps each handler
 * with audit logging + structured error translation, and stays transport
 * agnostic (stdio today; Streamable HTTP can be added later by wrapping
 * this same McpServer instance in a different transport — see index.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config/index.js";
import { AuditLogger, fingerprintSql, log } from "./logging/audit.js";
import { detectCapabilities } from "./db/capabilities.js";
import { McpToolError } from "./types/index.js";
import type { CapabilityFlags } from "./types/index.js";

import { getDatabaseInfo, getDatabaseInfoInput } from "./tools/database-info.js";
import { listSchemas, listSchemasInput } from "./tools/schemas.js";
import { describeTable, describeTableInput, listTables, listTablesInput } from "./tools/tables.js";
import { getIndexes, getIndexesInput } from "./tools/indexes.js";
import { getForeignKeys, getForeignKeysInput } from "./tools/foreign-keys.js";
import {
  describeProcedure,
  describeProcedureInput,
  getProcedureDefinition,
  getProcedureDefinitionInput,
} from "./tools/procedures.js";
import { executeSelect, executeSelectInput } from "./tools/query.js";
import { getEstimatedPlan, getEstimatedPlanInput } from "./tools/execution-plan.js";
import {
  queryStoreQuery,
  queryStoreQueryInput,
  queryStoreTopQueries,
  queryStoreTopQueriesInput,
} from "./tools/query-store.js";
import { getWaitStats, getWaitStatsInput } from "./tools/waits.js";
import {
  getActiveExpensiveQueries,
  getActiveExpensiveQueriesInput,
  getBlockingSummary,
  getDatabaseFiles,
  getIoStats,
  getMissingIndexStats,
  getMissingIndexStatsInput,
  getTableStats,
  getTableStatsInput,
} from "./tools/diagnostics.js";

type ToolResult = Record<string, unknown>;

function toContent(result: ToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function toErrorContent(err: unknown) {
  if (err instanceof McpToolError) {
    return { content: [{ type: "text" as const, text: JSON.stringify(err.toJSON(), null, 2) }], isError: true };
  }
  log.error("unexpected tool error");
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code: "DATABASE_ERROR", message: "Tool could not complete the request." } }, null, 2),
      },
    ],
    isError: true,
  };
}

export async function buildServer(config: AppConfig) {
  const audit = new AuditLogger(config);
  const capabilities = await detectCapabilities(config);

  const server = new McpServer({
    name: "sqlserver-review-mcp",
    version: "1.0.0",
  });

  /**
   * Wraps a tool handler with timing + audit logging. `describeForAudit`
   * lets callers avoid logging SQL text/rows (spec §17) by supplying
   * a fingerprint instead of the raw input.
   */
  function wrap<TInput>(
    toolName: string,
    handler: (input: TInput) => Promise<ToolResult>,
    describeForAudit?: (input: TInput) => Record<string, unknown>
  ) {
    return async (input: TInput) => {
      const start = Date.now();
      try {
        const result = await handler(input);
        const durationMs = Date.now() - start;
        const rowsReturned = Array.isArray((result as Record<string, unknown[]>)?.rows)
          ? (result.rows as unknown[]).length
          : undefined;
        audit.record({
          timestamp: new Date().toISOString(),
          tool: toolName,
          database: config.db.database,
          durationMs,
          rowsReturned,
          success: true,
          ...(describeForAudit ? describeForAudit(input) : {}),
        });
        return toContent(result);
      } catch (err) {
        const durationMs = Date.now() - start;
        audit.record({
          timestamp: new Date().toISOString(),
          tool: toolName,
          database: config.db.database,
          durationMs,
          success: false,
          errorCode: err instanceof McpToolError ? err.code : "DATABASE_ERROR",
          ...(describeForAudit ? describeForAudit(input) : {}),
        });
        return toErrorContent(err);
      }
    };
  }

  function sqlAuditFields(sqlText: string) {
    return {
      fingerprint: fingerprintSql(sqlText),
    };
  }

  // ---- 7.1 database info ---------------------------------------------
  server.registerTool(
    "sqlserver.get_database_info",
    {
      description: "Returns database/server metadata: version, edition, compatibility level, Query Store status, and other performance-relevant settings.",
      inputSchema: getDatabaseInfoInput.shape,
    },
    wrap("sqlserver.get_database_info", async () => getDatabaseInfo(config, capabilities))
  );

  // ---- 7.2 schemas ------------------------------------------------------
  server.registerTool(
    "sqlserver.list_schemas",
    {
      description: "Lists application schemas (excludes sys/INFORMATION_SCHEMA/guest). Supports an optional namePattern filter.",
      inputSchema: listSchemasInput.shape,
    },
    wrap("sqlserver.list_schemas", (input) => listSchemas(config, listSchemasInput.parse(input)))
  );

  // ---- 7.3 tables --------------------------------------------------------
  server.registerTool(
    "sqlserver.list_tables",
    {
      description: "Lists tables with approximate row counts (from partition metadata, never COUNT(*)) and table type.",
      inputSchema: listTablesInput.shape,
    },
    wrap("sqlserver.list_tables", (input) => listTables(config, listTablesInput.parse(input)))
  );

  // ---- 7.4 describe_table -------------------------------------------------
  server.registerTool(
    "sqlserver.describe_table",
    {
      description: "Describes a table's columns: data type, length, nullability, identity, computed, default, and primary-key participation. Never returns row data.",
      inputSchema: describeTableInput.shape,
    },
    wrap("sqlserver.describe_table", (input) => describeTable(config, describeTableInput.parse(input)))
  );

  // ---- 7.5 indexes ------------------------------------------------------
  server.registerTool(
    "sqlserver.get_indexes",
    {
      description: "Lists indexes on a table: type, uniqueness, key/included columns, filter definition, disabled status, and (where permitted) usage counters since last restart.",
      inputSchema: getIndexesInput.shape,
    },
    wrap("sqlserver.get_indexes", (input) => getIndexes(config, getIndexesInput.parse(input), capabilities))
  );

  // ---- 7.6 foreign keys --------------------------------------------------
  server.registerTool(
    "sqlserver.get_foreign_keys",
    {
      description: "Lists incoming and outgoing foreign-key relationships for a table, including delete/update actions.",
      inputSchema: getForeignKeysInput.shape,
    },
    wrap("sqlserver.get_foreign_keys", (input) => getForeignKeys(config, getForeignKeysInput.parse(input)))
  );

  // ---- stored procedures --------------------------------------------------
  server.registerTool(
    "sqlserver.describe_procedure",
    {
      description: "Lists a stored procedure's parameters (name, type, direction, default).",
      inputSchema: describeProcedureInput.shape,
    },
    wrap("sqlserver.describe_procedure", (input) => describeProcedure(config, describeProcedureInput.parse(input)))
  );

  server.registerTool(
    "sqlserver.get_procedure_definition",
    {
      description: "Returns a stored procedure's source text, if the review account has VIEW DEFINITION permission and the object is not encrypted. Read-only; never executes the procedure.",
      inputSchema: getProcedureDefinitionInput.shape,
    },
    wrap("sqlserver.get_procedure_definition", (input) =>
      getProcedureDefinition(config, getProcedureDefinitionInput.parse(input), capabilities)
    )
  );

  // ---- 8 generic query + 9 execution plan --------------------------------
  // Both tools are opt-in only (SQLSERVER_ENABLE_AD_HOC_SQL=true). They're
  // the only tools in this server that send CALLER-SUPPLIED SQL text to
  // SQL Server rather than fixed queries this codebase wrote itself — the
  // SQL guard blocks DML/DDL either way, but until that's confirmed against
  // the real locked-down account (mcp_code_review, not a broad test login)
  // both stay disabled. Every other tool below is unaffected.
  if (config.features.enableAdHocSql) {
    server.registerTool(
      "sqlserver.execute_select",
      {
        description:
          "Executes a single read-only SELECT statement (optionally with a leading WITH CTE). Enforces a SQL safety guard, row limit, and timeout. The SQL Server account itself cannot write, so this is defense-in-depth, not the sole safety mechanism.",
        inputSchema: executeSelectInput.shape,
      },
      wrap(
        "sqlserver.execute_select",
        (input) => executeSelect(config, executeSelectInput.parse(input)),
        (input) => sqlAuditFields((input as { sql: string }).sql)
      )
    );

    server.registerTool(
      "sqlserver.get_estimated_plan",
      {
        description:
          "Returns a normalized ESTIMATED execution plan (SET SHOWPLAN_XML) for a read-only SELECT: operators, estimated rows/cost, and detected warnings (scans, spills, implicit conversions, missing-index hints). The statement is never executed.",
        inputSchema: getEstimatedPlanInput.shape,
      },
      wrap(
        "sqlserver.get_estimated_plan",
        (input) => getEstimatedPlan(config, getEstimatedPlanInput.parse(input)),
        (input) => sqlAuditFields((input as { sql: string }).sql)
      )
    );
  } else {
    log.info(
      "sqlserver.execute_select and sqlserver.get_estimated_plan disabled (set SQLSERVER_ENABLE_AD_HOC_SQL=true to enable)"
    );
  }

  // ---- 10 query store -----------------------------------------------------
  server.registerTool(
    "sqlserver.query_store_top_queries",
    {
      description: "Returns the top Query Store queries over a lookback window, ordered by duration/cpu/logical_reads/executions.",
      inputSchema: queryStoreTopQueriesInput.shape,
    },
    wrap("sqlserver.query_store_top_queries", (input) =>
      queryStoreTopQueries(config, queryStoreTopQueriesInput.parse(input), capabilities)
    )
  );

  server.registerTool(
    "sqlserver.query_store_query",
    {
      description: "Returns Query Store history (text, plans, runtime stats, plan changes) for one query_id — useful for detecting regressions and parameter sniffing.",
      inputSchema: queryStoreQueryInput.shape,
    },
    wrap("sqlserver.query_store_query", (input) =>
      queryStoreQuery(config, queryStoreQueryInput.parse(input), capabilities)
    )
  );

  // ---- 11 wait stats -----------------------------------------------------
  server.registerTool(
    "sqlserver.get_wait_stats",
    {
      description: "Returns instance-level wait statistics, normalized into categories (CPU, Disk IO, Locking, Memory, Network, Parallelism, Log IO, Other). Cumulative since last restart; correlation, not automatic root cause.",
      inputSchema: getWaitStatsInput.shape,
    },
    wrap("sqlserver.get_wait_stats", (input) => getWaitStats(config, getWaitStatsInput.parse(input), capabilities))
  );

  // ---- 12 missing index diagnostics ---------------------------------------
  server.registerTool(
    "sqlserver.get_missing_index_stats",
    {
      description: "Returns SQL Server missing-index DMV suggestions with usage/impact stats. Advisory only — never converted automatically into CREATE INDEX.",
      inputSchema: getMissingIndexStatsInput.shape,
    },
    wrap("sqlserver.get_missing_index_stats", (input) =>
      getMissingIndexStats(config, getMissingIndexStatsInput.parse(input), capabilities)
    )
  );

  // ---- 13 optional high-value tools ---------------------------------------
  server.registerTool(
    "sqlserver.get_table_stats",
    {
      description: "Returns statistics-object metadata for a table (last updated, rows sampled, steps, columns) to help spot stale statistics.",
      inputSchema: getTableStatsInput.shape,
    },
    wrap("sqlserver.get_table_stats", (input) => getTableStats(config, getTableStatsInput.parse(input)))
  );

  server.registerTool(
    "sqlserver.get_index_usage",
    {
      description: "Alias of sqlserver.get_indexes usage data — included for workflow discoverability. Returns the same index list with usage counters.",
      inputSchema: getIndexesInput.shape,
    },
    wrap("sqlserver.get_index_usage", (input) => getIndexes(config, getIndexesInput.parse(input), capabilities))
  );

  server.registerTool(
    "sqlserver.get_database_files",
    {
      description: "Lists database files (data/log), sizes, growth settings, and physical paths.",
      inputSchema: {},
    },
    wrap("sqlserver.get_database_files", () => getDatabaseFiles(config))
  );

  server.registerTool(
    "sqlserver.get_io_stats",
    {
      description: "Returns per-file IO statistics (reads/writes, stall time) for the current database's data/log files.",
      inputSchema: {},
    },
    wrap("sqlserver.get_io_stats", () => getIoStats(config, capabilities))
  );

  server.registerTool(
    "sqlserver.get_blocking_summary",
    {
      description: "Returns a metadata-only snapshot of sessions currently blocked and their blockers. Never issues KILL or alters running requests.",
      inputSchema: {},
    },
    wrap("sqlserver.get_blocking_summary", () => getBlockingSummary(config, capabilities))
  );

  server.registerTool(
    "sqlserver.get_active_expensive_queries",
    {
      description: "Returns currently executing requests ordered by elapsed time, with CPU/logical reads and wait type. Metadata-only; never kills sessions or modifies requests.",
      inputSchema: getActiveExpensiveQueriesInput.shape,
    },
    wrap("sqlserver.get_active_expensive_queries", (input) =>
      getActiveExpensiveQueries(config, getActiveExpensiveQueriesInput.parse(input), capabilities)
    )
  );

  return { server, capabilities };
}

export type { CapabilityFlags };
