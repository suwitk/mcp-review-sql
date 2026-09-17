import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery, sql } from "../db/query.js";

export const listSchemasInput = z.object({
  namePattern: z.string().max(128).optional().describe("Substring or LIKE pattern to filter schema names (case-insensitive)."),
});
export type ListSchemasInput = z.infer<typeof listSchemasInput>;

export async function listSchemas(config: AppConfig, input: ListSchemasInput) {
  const pattern = input.namePattern ? `%${input.namePattern}%` : "%";
  const { rows } = await runQuery<{ schemaName: string; ownerName: string }>(
    config,
    `
    SELECT s.name AS schemaName, p.name AS ownerName
    FROM sys.schemas s
    JOIN sys.database_principals p ON p.principal_id = s.principal_id
    WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest')
      AND s.name LIKE @pattern
    ORDER BY s.name
    `,
    { pattern: { type: sql.NVarChar(256), value: pattern } }
  );
  return { schemas: rows };
}
