import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery } from "../db/query.js";
import type { CapabilityFlags } from "../types/index.js";
import { McpToolError } from "../types/index.js";

export const getWaitStatsInput = z.object({
  topN: z.number().int().positive().max(200).optional().default(20),
});
export type GetWaitStatsInput = z.infer<typeof getWaitStatsInput>;

// Ignorable "benign" waits that are almost always noise (SQL Server idle/background waits).
const BENIGN_WAITS = new Set([
  "BROKER_TO_FLUSH",
  "BROKER_TASK_STOP",
  "BROKER_EVENTHANDLER",
  "SLEEP_TASK",
  "SLEEP_SYSTEMTASK",
  "LAZYWRITER_SLEEP",
  "XE_TIMER_EVENT",
  "REQUEST_FOR_DEADLOCK_SEARCH",
  "LOGMGR_QUEUE",
  "CHECKPOINT_QUEUE",
  "CLR_AUTO_EVENT",
  "CLR_MANUAL_EVENT",
  "SQLTRACE_BUFFER_FLUSH",
  "WAITFOR",
  "DIRTY_PAGE_POLL",
  "HADR_FILESTREAM_IOMGR_IOCOMPLETION",
  "XE_DISPATCHER_WAIT",
  "FT_IFTS_SCHEDULER_IDLE_WAIT",
  "BROKER_RECEIVE_WAITFOR",
]);

function categorize(waitType: string): string {
  const w = waitType.toUpperCase();
  if (w.startsWith("PAGEIOLATCH") || w.startsWith("IO_COMPLETION") || w === "ASYNC_IO_COMPLETION" || w === "WRITELOG")
    return w === "WRITELOG" ? "Log IO" : "Disk IO";
  if (w.startsWith("LCK_")) return "Locking";
  if (w.startsWith("LATCH_") || w.startsWith("PAGELATCH")) return "Memory";
  if (w.startsWith("RESOURCE_SEMAPHORE") || w === "CMEMTHREAD") return "Memory";
  if (w.startsWith("CXPACKET") || w.startsWith("CXCONSUMER") || w.startsWith("EXCHANGE")) return "Parallelism";
  if (w.startsWith("ASYNC_NETWORK_IO") || w.startsWith("NET_WAITFOR_PACKET")) return "Network";
  if (w === "SOS_SCHEDULER_YIELD" || w === "THREADPOOL") return "CPU";
  if (w === "LOGMGR" || w.startsWith("LOG_")) return "Log IO";
  return "Other";
}

export async function getWaitStats(config: AppConfig, input: GetWaitStatsInput, capabilities: CapabilityFlags) {
  if (!capabilities.waitStats) {
    throw new McpToolError(
      "PERMISSION_DENIED",
      "VIEW SERVER STATE permission is required to read sys.dm_os_wait_stats. Ask a DBA to grant it to the review account."
    );
  }

  const { rows } = await runQuery<{
    waitType: string;
    waitingTasksCount: number;
    waitTimeMs: number;
    maxWaitTimeMs: number;
    signalTimeMs: number;
  }>(
    config,
    `
    SELECT TOP (200)
      wait_type AS waitType,
      waiting_tasks_count AS waitingTasksCount,
      wait_time_ms AS waitTimeMs,
      max_wait_time_ms AS maxWaitTimeMs,
      signal_wait_time_ms AS signalTimeMs
    FROM sys.dm_os_wait_stats
    WHERE waiting_tasks_count > 0
    ORDER BY wait_time_ms DESC
    `
  );

  const filtered = rows.filter((r) => !BENIGN_WAITS.has(r.waitType.toUpperCase())).slice(0, input.topN);

  const byCategory = new Map<string, number>();
  for (const r of filtered) {
    const cat = categorize(r.waitType);
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + r.waitTimeMs);
  }

  return {
    topWaits: filtered.map((r) => ({
      waitType: r.waitType,
      category: categorize(r.waitType),
      waitTimeMs: r.waitTimeMs,
      signalTimeMs: r.signalTimeMs,
      resourceWaitTimeMs: r.waitTimeMs - r.signalTimeMs,
      waitingTasksCount: r.waitingTasksCount,
      avgWaitMs: r.waitingTasksCount > 0 ? r.waitTimeMs / r.waitingTasksCount : 0,
    })),
    byCategory: Object.fromEntries(byCategory),
    note:
      "Waits are cumulative since the last SQL Server service restart or failover, across the whole instance (not just this database). A high cumulative wait indicates where sessions spent time waiting, not necessarily a single root cause — corroborate with Query Store and execution plans before concluding causation.",
  };
}
