import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery, sql } from "../db/query.js";
import type { CapabilityFlags } from "../types/index.js";

export const getIndexesInput = z.object({
  schema: z.string().min(1).max(128).default("dbo"),
  table: z.string().min(1).max(128),
});
export type GetIndexesInput = z.infer<typeof getIndexesInput>;

export async function getIndexes(config: AppConfig, input: GetIndexesInput, capabilities: CapabilityFlags) {
  const params = {
    schema: { type: sql.NVarChar(256), value: input.schema },
    table: { type: sql.NVarChar(256), value: input.table },
  };

  const { rows: indexRows } = await runQuery<{
    indexId: number;
    indexName: string;
    indexType: string;
    isUnique: boolean;
    isPrimaryKey: boolean;
    isDisabled: boolean;
    filterDefinition: string | null;
  }>(
    config,
    `
    SELECT
      i.index_id AS indexId,
      i.name AS indexName,
      i.type_desc AS indexType,
      i.is_unique AS isUnique,
      i.is_primary_key AS isPrimaryKey,
      i.is_disabled AS isDisabled,
      i.filter_definition AS filterDefinition
    FROM sys.indexes i
    JOIN sys.tables t ON t.object_id = i.object_id
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = @schema AND t.name = @table AND i.type > 0
    ORDER BY i.index_id
    `,
    params
  );

  const { rows: colRows } = await runQuery<{
    indexId: number;
    columnName: string;
    keyOrdinal: number;
    isDescending: boolean;
    isIncluded: boolean;
  }>(
    config,
    `
    SELECT
      ic.index_id AS indexId,
      c.name AS columnName,
      ic.key_ordinal AS keyOrdinal,
      ic.is_descending_key AS isDescending,
      ic.is_included_column AS isIncluded
    FROM sys.index_columns ic
    JOIN sys.tables t ON t.object_id = ic.object_id
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE s.name = @schema AND t.name = @table
    ORDER BY ic.index_id, ic.is_included_column, ic.key_ordinal
    `,
    params
  );

  let usageByIndexId = new Map<number, Record<string, unknown>>();
  if (capabilities.viewServerState) {
    try {
      const { rows: usageRows } = await runQuery<{
        indexId: number;
        userSeeks: number;
        userScans: number;
        userLookups: number;
        userUpdates: number;
        lastUserSeek: Date | null;
        lastUserScan: Date | null;
      }>(
        config,
        `
        SELECT
          us.index_id AS indexId,
          us.user_seeks AS userSeeks,
          us.user_scans AS userScans,
          us.user_lookups AS userLookups,
          us.user_updates AS userUpdates,
          us.last_user_seek AS lastUserSeek,
          us.last_user_scan AS lastUserScan
        FROM sys.dm_db_index_usage_stats us
        JOIN sys.tables t ON t.object_id = us.object_id
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = @schema AND t.name = @table AND us.database_id = DB_ID()
        `,
        params
      );
      usageByIndexId = new Map(usageRows.map((r) => [r.indexId, r]));
    } catch {
      // degrade gracefully
    }
  }

  const indexes = indexRows.map((idx) => {
    const keyColumns = colRows
      .filter((c) => c.indexId === idx.indexId && !c.isIncluded)
      .sort((a, b) => a.keyOrdinal - b.keyOrdinal)
      .map((c) => ({ column: c.columnName, direction: c.isDescending ? "DESC" : "ASC" }));

    const includedColumns = colRows
      .filter((c) => c.indexId === idx.indexId && c.isIncluded)
      .map((c) => c.columnName);

    const usage = usageByIndexId.get(idx.indexId);

    return {
      name: idx.indexName,
      type: idx.indexType,
      unique: !!idx.isUnique,
      primaryKey: !!idx.isPrimaryKey,
      disabled: !!idx.isDisabled,
      keyColumns,
      includedColumns,
      filterDefinition: idx.filterDefinition,
      usage: usage
        ? {
            userSeeks: usage.userSeeks,
            userScans: usage.userScans,
            userLookups: usage.userLookups,
            userUpdates: usage.userUpdates,
            lastUserSeek: usage.lastUserSeek,
            lastUserScan: usage.lastUserScan,
            note: "Usage counters reset on SQL Server service restart or failover; they reflect activity only since the last restart.",
          }
        : undefined,
    };
  });

  return {
    schema: input.schema,
    table: input.table,
    indexes,
    usageStatsAvailable: capabilities.viewServerState,
  };
}
