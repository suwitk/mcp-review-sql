/**
 * Configuration loaded from environment variables.
 *
 * Nothing here ever logs a secret. `redactedForLogging()` is the only
 * representation of config that is safe to print.
 */

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export interface AppConfig {
  db: {
    host: string;
    port: number;
    database: string;
    user?: string;
    password?: string;
    useWindowsAuth: boolean;
    useAzureAd: boolean;
    encrypt: boolean;
    trustServerCertificate: boolean;
    connectionTimeoutMs: number;
    queryTimeoutMs: number;
    poolMax: number;
    poolMin: number;
  };
  limits: {
    maxRows: number;
    defaultRows: number;
    maxQueryTextChars: number;
    maxPlanXmlChars: number;
  };
  logging: {
    level: string;
    auditEnabled: boolean;
  };
  redaction: {
    columnPatterns: string[];
  };
  features: {
    /**
     * Gates every tool that sends CALLER-SUPPLIED SQL text to the server
     * (sqlserver.execute_select, sqlserver.get_estimated_plan). The SQL
     * guard + DB account permissions are defense-in-depth either way, but
     * these are the only tools that aren't just running fixed, hardcoded
     * queries this codebase wrote itself — so both stay off by default and
     * only turn on with SQLSERVER_ENABLE_AD_HOC_SQL=true. Every other tool
     * (schema/index/FK/procedure discovery, Query Store, waits, missing
     * indexes, table stats, IO, blocking, active queries) is unaffected —
     * they only ever execute SQL text this codebase wrote itself.
     */
    enableAdHocSql: boolean;
  };
}

export function loadConfig(): AppConfig {
  const config: AppConfig = {
    db: {
      host: process.env.SQLSERVER_HOST ?? "",
      port: num("SQLSERVER_PORT", 1433),
      database: process.env.SQLSERVER_DATABASE ?? "",
      user: process.env.SQLSERVER_USER,
      password: process.env.SQLSERVER_PASSWORD,
      useWindowsAuth: bool("SQLSERVER_USE_WINDOWS_AUTH", false),
      useAzureAd: bool("SQLSERVER_USE_AZURE_AD", false),
      encrypt: bool("SQLSERVER_ENCRYPT", true),
      trustServerCertificate: bool("SQLSERVER_TRUST_SERVER_CERTIFICATE", false),
      connectionTimeoutMs: num("SQLSERVER_CONNECTION_TIMEOUT_MS", 10000),
      queryTimeoutMs: num("SQLSERVER_QUERY_TIMEOUT_MS", 15000),
      poolMax: num("SQLSERVER_POOL_MAX", 5),
      poolMin: num("SQLSERVER_POOL_MIN", 0),
    },
    limits: {
      maxRows: num("SQLSERVER_MAX_ROWS", 1000),
      defaultRows: num("SQLSERVER_DEFAULT_ROWS", 100),
      maxQueryTextChars: num("SQLSERVER_MAX_QUERY_TEXT_CHARS", 8000),
      maxPlanXmlChars: num("SQLSERVER_MAX_PLAN_XML_CHARS", 200000),
    },
    logging: {
      level: process.env.MCP_LOG_LEVEL ?? "info",
      auditEnabled: bool("MCP_AUDIT_LOG", true),
    },
    redaction: {
      columnPatterns: list("MCP_REDACT_COLUMNS", [
        "password",
        "password_hash",
        "token",
        "secret",
        "ssn",
        "credit_card",
        "api_key",
        "connection_string",
      ]),
    },
    features: {
      enableAdHocSql: bool("SQLSERVER_ENABLE_AD_HOC_SQL", false),
    },
  };

  if (!config.db.host) {
    throw new Error("SQLSERVER_HOST is required (set it in .env)");
  }
  if (!config.db.database) {
    throw new Error("SQLSERVER_DATABASE is required (set it in .env)");
  }
  if (!config.db.useWindowsAuth && !config.db.useAzureAd && !config.db.user) {
    throw new Error(
      "SQLSERVER_USER is required unless SQLSERVER_USE_WINDOWS_AUTH or SQLSERVER_USE_AZURE_AD is true"
    );
  }

  return config;
}

/** Safe-to-log summary of config. Never includes password/user secrets. */
export function redactedForLogging(config: AppConfig) {
  return {
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    authMode: config.db.useAzureAd
      ? "azure-ad"
      : config.db.useWindowsAuth
        ? "windows"
        : "sql",
    encrypt: config.db.encrypt,
    trustServerCertificate: config.db.trustServerCertificate,
    maxRows: config.limits.maxRows,
    queryTimeoutMs: config.db.queryTimeoutMs,
  };
}
