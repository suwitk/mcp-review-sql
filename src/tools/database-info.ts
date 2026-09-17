import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery } from "../db/query.js";
import type { CapabilityFlags } from "../types/index.js";

export const getDatabaseInfoInput = z.object({});

export async function getDatabaseInfo(config: AppConfig, capabilities: CapabilityFlags) {
  const { rows } = await runQuery<{
    database: string;
    serverVersion: string;
    edition: string;
    compatibilityLevel: number;
    isReadCommittedSnapshotOn: boolean;
    isAutoCloseOn: boolean;
    recoveryModel: string;
    collationName: string;
  }>(
    config,
    `
    SELECT
      DB_NAME()                                  AS [database],
      CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128))  AS serverVersion,
      CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128))         AS edition,
      d.compatibility_level                      AS compatibilityLevel,
      d.is_read_committed_snapshot_on             AS isReadCommittedSnapshotOn,
      d.is_auto_close_on                          AS isAutoCloseOn,
      d.recovery_model_desc                       AS recoveryModel,
      d.collation_name                            AS collationName
    FROM sys.databases d
    WHERE d.name = DB_NAME()
    `
  );

  const row = rows[0];

  let queryStoreEnabled = false;
  let queryStoreDesiredState: string | undefined;
  if (capabilities.queryStore) {
    try {
      const qs = await runQuery<{ actual_state_desc: string; desired_state_desc: string }>(
        config,
        "SELECT TOP (1) actual_state_desc, desired_state_desc FROM sys.database_query_store_options"
      );
      queryStoreEnabled = qs.rows[0]?.actual_state_desc === "READ_WRITE" || qs.rows[0]?.actual_state_desc === "READ_ONLY";
      queryStoreDesiredState = qs.rows[0]?.desired_state_desc;
    } catch {
      queryStoreEnabled = false;
    }
  }

  return {
    database: row?.database,
    serverVersion: row?.serverVersion,
    edition: row?.edition,
    compatibilityLevel: row?.compatibilityLevel,
    readCommittedSnapshot: !!row?.isReadCommittedSnapshotOn,
    autoClose: !!row?.isAutoCloseOn,
    recoveryModel: row?.recoveryModel,
    collation: row?.collationName,
    queryStoreEnabled,
    queryStoreDesiredState,
    capabilities,
  };
}
