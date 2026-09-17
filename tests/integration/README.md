# Integration tests

These are placeholders for running against a disposable SQL Server instance
(e.g. the `mcr.microsoft.com/mssql/server` Docker image) rather than mocks.

They are skipped automatically unless the following environment variables
are set, so `npm test` stays green in CI/dev environments without a live
SQL Server:

```
SQLSERVER_HOST
SQLSERVER_DATABASE
SQLSERVER_USER
SQLSERVER_PASSWORD
RUN_INTEGRATION_TESTS=true
```

Suggested setup for local integration testing:

```bash
docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=<StrongPassw0rd!>" \
  -p 1433:1433 --name mcp-test-sql -d mcr.microsoft.com/mssql/server:2022-latest

# then create a test database + the mcp_code_review account using
# sql/create-review-user.sql, and set the env vars above before
# running: RUN_INTEGRATION_TESTS=true npm test
```

Recommended coverage once wired to a live instance:
- `sqlserver.get_database_info` returns a plausible serverVersion/edition
- `sqlserver.list_tables` / `describe_table` / `get_indexes` / `get_foreign_keys`
  against a small known schema fixture
- `sqlserver.execute_select` timeout behavior (a deliberately slow query
  against a large generated table, with `SQLSERVER_QUERY_TIMEOUT_MS` set low)
- `sqlserver.execute_select` maximum row limit truncation
- Permission failure path: connect as a login with QUERY_STORE/VIEW SERVER
  STATE revoked and confirm graceful `FEATURE_UNAVAILABLE`/`PERMISSION_DENIED`
  responses rather than a crash
- The DB account itself cannot write: attempt `UPDATE`/`INSERT` directly
  with the mssql driver (bypassing the app-level guard) and confirm SQL
  Server rejects it — this is the real security boundary test.
