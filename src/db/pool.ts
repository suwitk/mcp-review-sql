/**
 * SQL Server connection pool.
 *
 * The pool connects with the credentials from config only. It never
 * elevates privileges and never runs DDL/DML — all safety here is about
 * connection lifecycle, not query validation (see security/sql-guard.ts).
 */
import sql from "mssql";
import type { AppConfig } from "../config/index.js";
import { log } from "../logging/audit.js";
import { McpToolError } from "../types/index.js";

let pool: sql.ConnectionPool | null = null;
let connecting: Promise<sql.ConnectionPool> | null = null;

function buildConfig(config: AppConfig): sql.config {
  const base: sql.config = {
    server: config.db.host,
    port: config.db.port,
    database: config.db.database,
    connectionTimeout: config.db.connectionTimeoutMs,
    requestTimeout: config.db.queryTimeoutMs,
    pool: {
      max: config.db.poolMax,
      min: config.db.poolMin,
      idleTimeoutMillis: 30000,
    },
    options: {
      encrypt: config.db.encrypt,
      trustServerCertificate: config.db.trustServerCertificate,
      enableArithAbort: true,
      // Read-only intent hint. SQL Server may route to a readable secondary
      // in an AG; it is NOT a substitute for account-level permissions.
      readOnlyIntent: true,
    },
  };

  if (config.db.useAzureAd) {
    return {
      ...base,
      authentication: {
        type: "azure-active-directory-default",
      },
    } as sql.config;
  }

  if (config.db.useWindowsAuth) {
    return {
      ...base,
      authentication: {
        type: "ntlm",
        options: {
          domain: process.env.SQLSERVER_DOMAIN ?? "",
          userName: config.db.user ?? "",
          password: config.db.password ?? "",
        },
      },
    } as sql.config;
  }

  return {
    ...base,
    user: config.db.user,
    password: config.db.password,
  };
}

export async function getPool(config: AppConfig): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const p = new sql.ConnectionPool(buildConfig(config));
      p.on("error", () => log.error("pool error"));
      await p.connect();
      pool = p;
      log.info("connected to SQL Server", { host: config.db.host, database: config.db.database });
      return p;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpToolError("CONNECTION_ERROR", `Failed to connect to SQL Server: ${message}`);
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
