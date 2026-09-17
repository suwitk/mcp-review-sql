import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery, sql } from "../db/query.js";

export const getForeignKeysInput = z.object({
  schema: z.string().min(1).max(128).default("dbo"),
  table: z.string().min(1).max(128),
});
export type GetForeignKeysInput = z.infer<typeof getForeignKeysInput>;

interface FkRow {
  fkName: string;
  sourceSchema: string;
  sourceTable: string;
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  deleteAction: string;
  updateAction: string;
}

const BASE_QUERY = `
SELECT
  fk.name AS fkName,
  ps.name AS sourceSchema,
  pt.name AS sourceTable,
  pc.name AS sourceColumn,
  rs.name AS targetSchema,
  rt.name AS targetTable,
  rc.name AS targetColumn,
  fk.delete_referential_action_desc AS deleteAction,
  fk.update_referential_action_desc AS updateAction
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
JOIN sys.columns pc ON pc.object_id = pt.object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = rt.object_id AND rc.column_id = fkc.referenced_column_id
`;

export async function getForeignKeys(config: AppConfig, input: GetForeignKeysInput) {
  const params = {
    schema: { type: sql.NVarChar(256), value: input.schema },
    table: { type: sql.NVarChar(256), value: input.table },
  };

  const { rows: outgoing } = await runQuery<FkRow>(
    config,
    `${BASE_QUERY} WHERE ps.name = @schema AND pt.name = @table ORDER BY fk.name`,
    params
  );

  const { rows: incoming } = await runQuery<FkRow>(
    config,
    `${BASE_QUERY} WHERE rs.name = @schema AND rt.name = @table ORDER BY fk.name`,
    params
  );

  // Composite FKs produce one row per column pair; group them by constraint name.
  function groupByConstraint(fkRows: FkRow[]) {
    const byName = new Map<string, ReturnType<typeof shapeFirst>>();
    function shapeFirst(r: FkRow) {
      return {
        constraintName: r.fkName,
        sourceTable: `${r.sourceSchema}.${r.sourceTable}`,
        sourceColumns: [r.sourceColumn] as string[],
        targetTable: `${r.targetSchema}.${r.targetTable}`,
        targetColumns: [r.targetColumn] as string[],
        onDelete: r.deleteAction,
        onUpdate: r.updateAction,
      };
    }
    for (const r of fkRows) {
      const existing = byName.get(r.fkName);
      if (existing) {
        existing.sourceColumns.push(r.sourceColumn);
        existing.targetColumns.push(r.targetColumn);
      } else {
        byName.set(r.fkName, shapeFirst(r));
      }
    }
    return Array.from(byName.values());
  }

  return {
    schema: input.schema,
    table: input.table,
    outgoing: groupByConstraint(outgoing),
    incoming: groupByConstraint(incoming),
  };
}
