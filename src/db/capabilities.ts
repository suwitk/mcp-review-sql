/**
 * Capability detection (spec §19).
 *
 * Runs a set of best-effort probes at startup so tools can degrade
 * gracefully instead of throwing when an optional DMV/permission is
 * unavailable. A missing capability never crashes the server.
 */
import type { AppConfig } from "../config/index.js";
import { runQuery } from "./query.js";
import type { CapabilityFlags } from "../types/index.js";
import { log } from "../logging/audit.js";

async function probe(config: AppConfig, sql: string): Promise<boolean> {
  try {
    await runQuery(config, sql, {}, { maxRows: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function detectCapabilities(config: AppConfig): Promise<CapabilityFlags> {
  const reason: Record<string, string> = {};

  const queryStore = await probe(
    config,
    "SELECT TOP (1) actual_state FROM sys.database_query_store_options"
  );
  if (!queryStore) reason.queryStore = "Query Store catalog view unavailable or not permitted";

  const waitStats = await probe(config, "SELECT TOP (1) wait_type FROM sys.dm_os_wait_stats");
  if (!waitStats) reason.waitStats = "VIEW SERVER STATE permission required for sys.dm_os_wait_stats";

  const missingIndexDmv = await probe(
    config,
    "SELECT TOP (1) database_id FROM sys.dm_db_missing_index_details"
  );
  if (!missingIndexDmv) reason.missingIndexDmv = "VIEW SERVER STATE permission required";

  const viewServerState = await probe(
    config,
    "SELECT TOP (1) session_id FROM sys.dm_exec_sessions"
  );
  if (!viewServerState) reason.viewServerState = "VIEW SERVER STATE permission unavailable";

  const viewDefinition = await probe(
    config,
    "SELECT TOP (1) OBJECT_DEFINITION(object_id) FROM sys.objects WHERE type = 'P'"
  );
  if (!viewDefinition) reason.viewDefinition = "VIEW DEFINITION permission unavailable";

  const ioStats = await probe(
    config,
    "SELECT TOP (1) database_id FROM sys.dm_io_virtual_file_stats(DB_ID(), NULL)"
  );
  if (!ioStats) reason.ioStats = "VIEW SERVER STATE permission required for IO file stats";

  const blockingInfo = await probe(
    config,
    "SELECT TOP (1) session_id FROM sys.dm_os_waiting_tasks"
  );
  if (!blockingInfo) reason.blockingInfo = "VIEW SERVER STATE permission required";

  const flags: CapabilityFlags = {
    queryStore,
    waitStats,
    missingIndexDmv,
    viewServerState,
    viewDefinition,
    ioStats,
    blockingInfo,
    reason,
  };

  log.info("capability detection complete", { ...flags });
  return flags;
}
