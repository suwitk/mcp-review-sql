import { z } from "zod";
import type { AppConfig } from "../config/index.js";
import { runQuery, sql } from "../db/query.js";
import { McpToolError, type CapabilityFlags } from "../types/index.js";
import { truncateText } from "../security/limits.js";

export const describeProcedureInput = z.object({
  schema: z.string().min(1).max(128).default("dbo"),
  procedure: z.string().min(1).max(128),
});
export type DescribeProcedureInput = z.infer<typeof describeProcedureInput>;

async function findProcedure(config: AppConfig, schema: string, procedure: string) {
  const { rows } = await runQuery<{ objectId: number; createdAt: Date; modifiedAt: Date }>(
    config,
    `
    SELECT p.object_id AS objectId, p.create_date AS createdAt, p.modify_date AS modifiedAt
    FROM sys.procedures p
    JOIN sys.schemas s ON s.schema_id = p.schema_id
    WHERE s.name = @schema AND p.name = @procedure
    `,
    {
      schema: { type: sql.NVarChar(256), value: schema },
      procedure: { type: sql.NVarChar(256), value: procedure },
    }
  );
  return rows[0];
}

export async function describeProcedure(config: AppConfig, input: DescribeProcedureInput) {
  const proc = await findProcedure(config, input.schema, input.procedure);
  if (!proc) {
    return { schema: input.schema, procedure: input.procedure, found: false, parameters: [] };
  }

  const { rows: parameters } = await runQuery<{
    parameterName: string;
    dataType: string;
    maxLength: number | null;
    isOutput: boolean;
    hasDefault: boolean;
    ordinalPosition: number;
  }>(
    config,
    `
    SELECT
      par.name AS parameterName,
      ty.name AS dataType,
      par.max_length AS maxLength,
      par.is_output AS isOutput,
      par.has_default_value AS hasDefault,
      par.parameter_id AS ordinalPosition
    FROM sys.parameters par
    JOIN sys.types ty ON ty.user_type_id = par.user_type_id
    WHERE par.object_id = @objectId
    ORDER BY par.parameter_id
    `,
    { objectId: { type: sql.Int, value: proc.objectId } }
  );

  return {
    schema: input.schema,
    procedure: input.procedure,
    found: true,
    createdAt: proc.createdAt,
    modifiedAt: proc.modifiedAt,
    parameters,
  };
}

export const getProcedureDefinitionInput = z.object({
  schema: z.string().min(1).max(128).default("dbo"),
  procedure: z.string().min(1).max(128),
});
export type GetProcedureDefinitionInput = z.infer<typeof getProcedureDefinitionInput>;

export async function getProcedureDefinition(
  config: AppConfig,
  input: GetProcedureDefinitionInput,
  capabilities: CapabilityFlags
) {
  if (!capabilities.viewDefinition) {
    throw new McpToolError(
      "FEATURE_UNAVAILABLE",
      "The review account does not have VIEW DEFINITION permission, so procedure source cannot be read."
    );
  }

  const proc = await findProcedure(config, input.schema, input.procedure);
  if (!proc) {
    return { schema: input.schema, procedure: input.procedure, found: false, definition: null };
  }

  const { rows } = await runQuery<{ definition: string }>(
    config,
    `SELECT OBJECT_DEFINITION(@objectId) AS definition`,
    { objectId: { type: sql.Int, value: proc.objectId } }
  );

  const definition = rows[0]?.definition ?? null;
  if (definition === null) {
    return {
      schema: input.schema,
      procedure: input.procedure,
      found: true,
      definition: null,
      note: "Definition is not accessible. It may be encrypted (WITH ENCRYPTION) or the review account lacks VIEW DEFINITION on this object.",
    };
  }

  const { text, truncated } = truncateText(definition, config.limits.maxQueryTextChars * 4);
  return { schema: input.schema, procedure: input.procedure, found: true, definition: text, truncated };
}
