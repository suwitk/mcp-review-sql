# SQL Server Review MCP

A production-safe, **read-only** Model Context Protocol (MCP) server for
Microsoft SQL Server. It gives an AI coding/review agent an observability
and diagnostic interface for end-to-end performance and architecture
reviews:

```
Browser Network → Frontend → Backend/API → Service/Repository
  → SQL / Stored Procedure → SQL Server → Execution Plan
  → Query Store → Tables / Indexes / Statistics
```

> **This MCP is intended for read-only application diagnostics and
> performance review. It must not be deployed with sysadmin, db_owner, or
> application write credentials.**

## 1. Purpose

The MCP is an evidence-gathering tool for an AI reviewer, not a database
administration interface. It cannot modify application data, schema,
indexes, statistics, Query Store configuration, server configuration, or
any other SQL Server state. See [Non-goals](#non-goals).

## 2. Architecture

```
AI Agent (MCP client)
   |  stdio (JSON-RPC)
   v
McpServer (src/server.ts)
   |
   +-- Tool handlers (src/tools/*)
   |     |
   |     v
   +-- Security layer (src/security/*)
   |     - sql-guard.ts   : tokenizer-based SELECT-only guard
   |     - redaction.ts   : column-based value redaction
   |     - limits.ts      : row caps / text truncation
   |
   +-- db/query.ts  -> db/pool.ts  -> mssql -> SQL Server
   |
   +-- db/capabilities.ts : startup probes, graceful degradation
   +-- logging/audit.ts   : structured JSON logs + audit trail
```

Defense in depth (spec §5):

```
AI Agent
   -> MCP input validation (zod)
   -> SQL safety guard (tokenizer, not just regex)
   -> Query timeout / row limit
   -> Read-only SQL Server account   <-- the REAL boundary
   -> SQL Server permissions
```

The SQL guard is **defense-in-depth only**. The actual security boundary
is the `mcp_code_review` SQL Server account, which is physically unable to
write (see [SQL Server account setup](#5-sql-server-account-setup)).

Transport: **stdio** only in V1. The tool/DB logic in `src/tools`,
`src/db`, and `src/security` has no transport dependency, so a Streamable
HTTP transport can be added later by wrapping the same `McpServer`
instance built in `src/server.ts` — no other code needs to change.

## 3. Installation

```bash
cd sqlserver-review-mcp
npm install
cp .env.example .env   # then fill in .env
npm run build
npm start               # runs dist/index.js over stdio
```

For local development without a build step:

```bash
npm run dev              # tsx src/index.ts
```

Run tests:

```bash
npm test
```

## 4. Environment variables

See `.env.example` for the full list with defaults. Highlights:

| Variable | Purpose |
|---|---|
| `SQLSERVER_HOST`, `SQLSERVER_PORT`, `SQLSERVER_DATABASE` | Connection target |
| `SQLSERVER_USER` / `SQLSERVER_PASSWORD` | SQL auth credentials (ignored if Windows/Azure AD auth is used) |
| `SQLSERVER_USE_WINDOWS_AUTH` | Use integrated/Windows auth instead of SQL auth |
| `SQLSERVER_USE_AZURE_AD` | Use Entra ID (Azure AD) default credential auth for Azure SQL Database |
| `SQLSERVER_ENCRYPT`, `SQLSERVER_TRUST_SERVER_CERTIFICATE` | TLS settings |
| `SQLSERVER_QUERY_TIMEOUT_MS`, `SQLSERVER_CONNECTION_TIMEOUT_MS` | Timeouts |
| `SQLSERVER_MAX_ROWS`, `SQLSERVER_DEFAULT_ROWS` | Global row caps (spec §15) |
| `SQLSERVER_MAX_QUERY_TEXT_CHARS`, `SQLSERVER_MAX_PLAN_XML_CHARS` | Response-size caps |
| `MCP_LOG_LEVEL`, `MCP_AUDIT_LOG` | Logging (stderr only; stdout is reserved for the MCP protocol) |
| `MCP_REDACT_COLUMNS` | Comma-separated column-name substrings to redact in `execute_select` results |
| `SQLSERVER_ENABLE_AD_HOC_SQL` | Off by default. Set `true` to register `execute_select`/`get_estimated_plan` (the only tools that run caller-supplied SQL) |

Credentials are never logged. `src/config/index.ts`'s `redactedForLogging()`
is the only config representation that is ever written to the log stream.

## 5. SQL Server account setup

Run `sql/create-review-user.sql` as a DBA. It creates a dedicated account
(conceptually `mcp_code_review`) and grants **only**:

- schema/table/index/FK/procedure **metadata** (via built-in visibility +
  `VIEW DEFINITION`)
- `VIEW DATABASE STATE` (Query Store catalog views, database-scoped DMVs)
- optionally `db_datareader`, only if the review genuinely needs to read
  table data (many reviews only need metadata + Query Store + plans)
- optionally, server-level `VIEW SERVER STATE` for instance-wide
  diagnostics (wait stats, missing-index DMVs, IO stats, blocking,
  active-request inspection) — **requires a server-level admin**, and
  exposes session/query text for the **whole instance**, not just this
  database

It never grants: `sysadmin`, `serveradmin`, `securityadmin`, `db_owner`,
`db_ddladmin`, `db_datawriter`, `CONTROL SERVER`, broad `ALTER`, `INSERT`,
`UPDATE`, `DELETE`, or broad `EXECUTE`.

Run `sql/verify-permissions.sql` afterward (as the new account) to confirm
writes fail and the expected reads succeed.

### Authentication model differences

| Model | Where to configure | Notes |
|---|---|---|
| SQL Authentication (on-prem/IaaS) | Section A of `create-review-user.sql`; `SQLSERVER_USER`/`PASSWORD` in `.env` | Simplest; rotate the password regularly |
| Windows Authentication | Section B; `SQLSERVER_USE_WINDOWS_AUTH=true`; run the MCP process under that Windows identity or a gMSA | No password in `.env` |
| Azure SQL Database + Entra ID | Section C; `SQLSERVER_USE_AZURE_AD=true` | No server-level login step — the database user IS the principal. Some instance-wide DMVs (`sys.dm_os_wait_stats`, file-level IO stats) are not exposed the same way; use the Azure SQL equivalents (`sys.dm_db_wait_stats`, `sys.dm_db_resource_stats`). Query Store is on by default. |

## 6. MCP client configuration

Example stdio client config (Claude Desktop / any MCP-compatible client):

```json
{
  "mcpServers": {
    "sqlserver-review": {
      "command": "node",
      "args": ["/absolute/path/to/sqlserver-review-mcp/dist/index.js"],
      "env": {
        "SQLSERVER_HOST": "your-sql-host",
        "SQLSERVER_DATABASE": "YourAppDb",
        "SQLSERVER_USER": "mcp_code_review",
        "SQLSERVER_PASSWORD": "***"
      }
    }
  }
}
```

### Install as a Claude Desktop Extension (unpacked, via manifest.json)

This project ships a `manifest.json` (Desktop Extension / DXT format) so it
can be installed through **Settings → Extensions** instead of hand-editing
a JSON config:

1. `npm install && npm run build` — this must be done manually first;
   installing as an unpacked extension does **not** run `npm install` for
   you, so `dist/` and `node_modules/` must already exist in the folder.
2. Open the Claude app → **Settings → Extensions**.
3. Click **"Install unpacked extension"** and select this project's root
   folder (the one containing `manifest.json`).
4. Fill in the configuration form: SQL Server host, database, and the
   `mcp_code_review` login/password (or enable Windows/Entra ID auth
   instead of a password — see §5). Everything else has a sensible
   default from `.env.example`.
5. Enable the extension and start asking questions in chat.

If the form rejects a value or the extension fails to start, check the
error text against [Troubleshooting](#13-troubleshooting) — `manifest.json`
maps every form field straight to the same environment variables used by
the plain stdio setup below, so the same fixes apply.

## 7. Available tools

| Tool | Purpose |
|---|---|
| `sqlserver.get_database_info` | Server/database metadata, Query Store status |
| `sqlserver.list_schemas` | List application schemas |
| `sqlserver.list_tables` | List tables + approximate row counts (metadata, never `COUNT(*)`) |
| `sqlserver.describe_table` | Column definitions (never row data) |
| `sqlserver.get_indexes` | Index definitions + usage counters where permitted |
| `sqlserver.get_foreign_keys` | Incoming/outgoing FK relationships |
| `sqlserver.describe_procedure` | Stored procedure parameters |
| `sqlserver.get_procedure_definition` | Stored procedure source (if `VIEW DEFINITION` is available and object isn't encrypted) |
| `sqlserver.execute_select` *(opt-in)* | Restricted, guarded, single read-only `SELECT` |
| `sqlserver.get_estimated_plan` *(opt-in)* | Normalized ESTIMATED execution plan (no execution) |
| `sqlserver.query_store_top_queries` | Top Query Store queries by duration/cpu/logical_reads/executions |
| `sqlserver.query_store_query` | Query Store plans and bounded runtime history by interval for one `query_id` |
| `sqlserver.get_wait_stats` | Instance-level wait statistics, categorized |
| `sqlserver.get_missing_index_stats` | Missing-index DMV suggestions (advisory only) |
| `sqlserver.get_table_stats` | Statistics-object staleness/metadata |
| `sqlserver.get_index_usage` | Same as `get_indexes`, exposed under the workflow-oriented name |
| `sqlserver.get_database_files` | Data/log file sizes, growth settings |
| `sqlserver.get_io_stats` | Per-file IO stall/throughput stats |
| `sqlserver.get_blocking_summary` | Metadata-only blocked-session snapshot (no `KILL`) |
| `sqlserver.get_active_expensive_queries` | Currently executing requests, metadata-only |

`sqlserver.execute_select` and `sqlserver.get_estimated_plan` are the only
two tools that run **caller-supplied SQL text** rather than fixed queries
this codebase wrote itself. They are disabled by default and only
registered when `SQLSERVER_ENABLE_AD_HOC_SQL=true` — every other tool in
the table above is unaffected by this flag either way. Turn it on only
once `SQLSERVER_USER` is the locked-down `mcp_code_review` login (see §5),
never a broad test/admin account.

Every tool degrades gracefully (an informative `FEATURE_UNAVAILABLE` /
`PERMISSION_DENIED` error, not a crash) if its underlying permission or
feature (e.g. Query Store) is unavailable — see
[Capability detection](#capability-detection).

## 8. Tool examples

`sqlserver.list_tables`:
```json
{ "schema": "dbo", "namePattern": "Order" }
```

`sqlserver.execute_select`:
```json
{
  "sql": "SELECT TOP (10) Id, Status FROM dbo.Orders WHERE CustomerId = @customerId",
  "parameters": { "customerId": 42 },
  "maxRows": 10
}
```

`sqlserver.query_store_top_queries`:
```json
{ "lookbackHours": 24, "orderBy": "duration", "limit": 20 }
```

`sqlserver.get_estimated_plan`:
```json
{ "sql": "SELECT * FROM dbo.Customers WHERE Email = @email", "parameters": { "email": "a@b.com" } }
```

## 9. Security model

- **The database account is the real boundary.** The SQL guard
  (`src/security/sql-guard.ts`) is defense-in-depth: it tokenizes the
  statement (masking string literals and comments first, so content
  inside quotes/comments can never influence the decision), rejects
  multiple batches, rejects anything that isn't a single `SELECT`
  (optionally led by `WITH` for a CTE), and rejects DML/DDL keywords,
  `EXEC`/`EXECUTE`, `sp_*`/`xp_*` procedure calls, `SELECT ... INTO`, and
  `OPENROWSET`/`OPENDATASOURCE`/`OPENQUERY`.
- Every request has an enforced timeout (`SQLSERVER_QUERY_TIMEOUT_MS`) and
  a response row cap (`SQLSERVER_MAX_ROWS`). Capped queries stream and cancel
  on the first extra row, so the driver does not collect an unbounded result.
  A costly scan before the first rows arrive can still consume server time.
- `sqlserver.execute_select` uses parameterized inputs (`parameters`
  becomes `sql.Request.input(...)` calls, not string concatenation).
- Column-name based redaction (`MCP_REDACT_COLUMNS`) replaces sensitive
  values with `***REDACTED***` in any tool that returns row data. Schema
  metadata tools may still report that a sensitive column *exists*.
- Every tool call is audit-logged (`src/logging/audit.ts`) with a
  fingerprint for generic SQL, never query text/row data, to
  stderr as structured JSON (stdout is reserved for the MCP protocol).
- Errors are structured (`INVALID_INPUT`, `UNSAFE_QUERY`,
  `PERMISSION_DENIED`, `QUERY_TIMEOUT`, `ROW_LIMIT_EXCEEDED`,
  `QUERY_STORE_DISABLED`, `FEATURE_UNAVAILABLE`, `DATABASE_ERROR`,
  `CONNECTION_ERROR`) and never leak credentials or raw driver internals.

## 10. Production safety recommendations

- Prefer connecting this MCP to a **staging environment, sanitized
  replica, or reporting/readable-secondary replica** rather than
  production customer data whenever possible.
- Grant `VIEW SERVER STATE` only if you accept that it exposes
  instance-wide session/query text, not just this application's database.
- Keep `SQLSERVER_MAX_ROWS` and `SQLSERVER_QUERY_TIMEOUT_MS` conservative
  in production; raise them deliberately for a specific investigation.
- Rotate the `mcp_code_review` credential regularly; treat it like any
  other service account.
- Review `MCP_REDACT_COLUMNS` against your actual schema — the default
  list is a starting point, not a guarantee.
- Periodically re-run `sql/verify-permissions.sql` after any role/grant
  changes elsewhere in the database.

## 11. Query Store requirements

Several tools (`query_store_top_queries`, `query_store_query`, and the
`queryStoreEnabled` flag in `get_database_info`) require Query Store to be
enabled on the target database:

```sql
ALTER DATABASE [YourAppDb] SET QUERY_STORE = ON;
ALTER DATABASE [YourAppDb] SET QUERY_STORE (OPERATION_MODE = READ_WRITE);
```

This requires a DBA; the MCP never enables or configures Query Store
itself (that would be a write to database configuration). If Query Store
is disabled or inaccessible, Query Store tools return a structured
`QUERY_STORE_DISABLED` error rather than crashing the server, and every
other tool continues to work normally.

Azure SQL Database has Query Store enabled by default and cannot disable
it entirely, so these tools are effectively always available there
(subject to permissions).

## 12. Required SQL Server permissions

| Capability | Permission | DMV / catalog view |
|---|---|---|
| Schema/table/index/FK metadata | none beyond database membership (visible via catalog views) | `sys.schemas`, `sys.tables`, `sys.columns`, `sys.indexes`, `sys.foreign_keys` |
| Procedure parameters | none beyond database membership | `sys.parameters` |
| Procedure source | `VIEW DEFINITION` | `OBJECT_DEFINITION()` |
| Query Store | `VIEW DATABASE STATE` (or implicit via catalog view visibility, version-dependent) | `sys.query_store_*` |
| Estimated plan | `SHOWPLAN` plus permission to execute the SELECT on every referenced object/database | `SET SHOWPLAN_XML` |
| Wait stats | `VIEW SERVER STATE` (server-level) | `sys.dm_os_wait_stats` |
| Missing-index suggestions | `VIEW SERVER STATE` | `sys.dm_db_missing_index_*` |
| IO stats | `VIEW SERVER STATE` | `sys.dm_io_virtual_file_stats` |
| Blocking summary | `VIEW SERVER STATE` | `sys.dm_os_waiting_tasks` |
| Active expensive queries | `VIEW SERVER STATE` | `sys.dm_exec_requests`, `sys.dm_exec_sql_text` |
| Table statistics metadata | none beyond database membership | `sys.stats`, `sys.dm_db_stats_properties` |

**SQL Server version notes:** DMV shapes above are stable from SQL Server
2016 through 2022. Query Store requires SQL Server 2016+ or Azure SQL
Database. On Azure SQL Database, server-level `VIEW SERVER STATE` does
not exist the same way — use the database-scoped equivalents
(`sys.dm_db_wait_stats`, `sys.dm_db_resource_stats`) if adapting this MCP
further; V1 as shipped targets on-prem/IaaS SQL Server for the
`VIEW SERVER STATE`-gated tools and degrades those tools gracefully on
Azure SQL Database.

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `CONNECTION_ERROR` on startup | Wrong host/port, firewall, or TLS mismatch | Check `SQLSERVER_HOST`/`PORT`, `SQLSERVER_ENCRYPT`/`TRUST_SERVER_CERTIFICATE` |
| Every tool works except wait stats / missing-index / IO / blocking / active-queries | `VIEW SERVER STATE` not granted | Expected — see capability detection; grant it if you accept the instance-wide exposure |
| `QUERY_STORE_DISABLED` | Query Store not enabled on the database | Ask a DBA to enable it (see §11) |
| `sqlserver.get_procedure_definition` returns `definition: null` | Object created `WITH ENCRYPTION`, or `VIEW DEFINITION` missing | Expected/by design; cannot be bypassed |
| `UNSAFE_QUERY` on a query you believe is safe | Multiple batches, a banned keyword token, or `SELECT...INTO` | Submit exactly one `SELECT` (optionally `WITH` CTE); check for stray semicolons |
| `QUERY_TIMEOUT` | Query genuinely expensive, or timeout set too low | Raise `SQLSERVER_QUERY_TIMEOUT_MS` deliberately, or optimize the query first (that's the point of this tool) |
| Rows silently missing from `execute_select` | Response truncated at `SQLSERVER_MAX_ROWS` | `truncated: true` / `limitNote` in the response signals this; refine the filter |

## Capability detection

On startup (`src/db/capabilities.ts`), the server probes each optional
DMV/permission once and logs the result. Tools built on an unavailable
capability return a structured error immediately instead of failing the
whole server. Example shape:

```json
{
  "queryStore": true,
  "waitStats": false,
  "reason": { "waitStats": "VIEW SERVER STATE permission required for sys.dm_os_wait_stats" }
}
```

## Non-goals

V1 deliberately does **not**: modify records, create/drop indexes, update
statistics, rebuild indexes, kill SQL sessions, modify Query Store,
change database configuration, execute arbitrary stored procedures,
perform migrations, create users dynamically, manage backups, or
automatically apply recommendations. Recommendations belong in the
review report; execution of fixes belongs to engineers/DBAs.

## Expected AI review workflow

The tools are designed to answer, with evidence:

> "What tables does this API appear to use?" · "What indexes exist on
> this table?" · "Which Query Store query corresponds to this repository
> SQL?" · "Why is this query expensive?" · "Is this endpoint CPU, IO,
> locking, network, frontend, or database bound?" · "What evidence
> supports that conclusion?" · "What change should engineers
> investigate?"

But never: "Fix it." This MCP provides evidence and diagnostics; humans
control production changes.
