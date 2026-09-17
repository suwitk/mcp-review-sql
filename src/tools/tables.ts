import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery, sql } from "../db/query.js";
import { clampMaxRows } from "../security/limits.js";

export const listTablesInput = z.object({
  schema: z.string().max(128).optional().describe("Restrict to a single schema, e.g. 'dbo'."),
  namePattern: z.string().max(128).optional().describe("Substring to match against table name."),
  maxRows: z.number().int().positive().optional(),
});
export type ListTablesInput = z.infer<typeof listTablesInput>;

export async function listTables(config: AppConfig, input: ListTablesInput) {
  const maxRows = clampMaxRows(input.maxRows, config);
  const namePattern = input.namePattern ? `%${input.namePattern}%` : "%";
  const schemaPattern = input.schema ?? "%";

  // Row counts come from sys.dm_db_partition_stats (metadata), never COUNT(*).
  const { rows, truncated } = await runQuery<{
    schemaName: string;
    tableName: string;
    tableType: string;
    approxRowCount: number;
    createdAt: Date;
    modifiedAt: Date;
  }>(
    config,
    `
    SELECT
      s.name AS schemaName,
      t.name AS tableName,
      CASE WHEN t.temporal_type = 2 THEN 'SYSTEM_VERSIONED_TEMPORAL' ELSE 'BASE_TABLE' END AS tableType,
      ISNULL(ps.row_count, 0) AS approxRowCount,
      t.create_date AS createdAt,
      t.modify_date AS modifiedAt
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    OUTER APPLY (
      SELECT SUM(p.rows) AS row_count
      FROM sys.partitions p
      WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)
    ) ps
    WHERE s.name LIKE @schemaPattern
      AND t.name LIKE @namePattern
      AND s.name NOT IN ('sys')
    ORDER BY s.name, t.name
    `,
    {
      schemaPattern: { type: sql.NVarChar(256), value: schemaPattern },
      namePattern: { type: sql.NVarChar(256), value: namePattern },
    },
    { maxRows }
  );

  return { tables: rows, truncated, maxRows };
}

export const describeTableInput = z.object({
  schema: z.string().min(1).max(128).default("dbo"),
  table: z.string().min(1).max(128),
});
export type DescribeTableInput = z.infer<typeof describeTableInput>;

export async function describeTable(config: AppConfig, input: DescribeTableInput) {
  const params = {
    schema: { type: sql.NVarChar(256), value: input.schema },
    table: { type: sql.NVarChar(256), value: input.table },
  };

  const { rows: columns } = await runQuery<{
    columnName: string;
    dataType: string;
    maxLength: number | null;
    precision: number | null;
    scale: number | null;
    isNullable: boolean;
    isIdentity: boolean;
    isComputed: boolean;
    computedDefinition: string | null;
    defaultDefinition: string | null;
    ordinalPosition: number;
    isPrimaryKey: boolean;
  }>(
    config,
    `
    SELECT
      c.name AS columnName,
      ty.name AS dataType,
      c.max_length AS maxLength,
      c.precision AS precision,
      c.scale AS scale,
      c.is_nullable AS isNullable,
      c.is_identity AS isIdentity,
      c.is_computed AS isComputed,
      cc.definition AS computedDefinition,
      dc.definition AS defaultDefinition,
      c.column_id AS ordinalPosition,
      CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.columns c ON c.object_id = t.object_id
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
    LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
    LEFT JOIN (
      SELECT ic.column_id, ic.object_id
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      WHERE i.is_primary_key = 1
    ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
    WHERE s.name = @schema AND t.name = @table
    ORDER BY c.column_id
    `,
    params
  );

  if (columns.length === 0) {
    return { schema: input.schema, table: input.table, found: false, columns: [] };
  }

  return { schema: input.schema, table: input.table, found: true, columns };
}
