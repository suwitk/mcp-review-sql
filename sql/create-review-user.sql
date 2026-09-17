/* =========================================================================
   sqlserver-review-mcp — create-review-user.sql

   Creates a dedicated, read-only login/user (conceptually "mcp_code_review")
   for the SQL Server Review MCP. Run each applicable section as a DBA.

   IMPORTANT
   ---------
   This account is the REAL security boundary for this MCP (spec §5/§6).
   The application-level SQL guard (src/security/sql-guard.ts) is
   defense-in-depth ONLY. Do NOT grant any of the following to this
   account, ever:
     sysadmin, serveradmin, securityadmin, db_owner, db_ddladmin,
     db_datawriter, CONTROL SERVER, ALTER (broad), INSERT, UPDATE, DELETE,
     broad EXECUTE, or any write permission.

   Pick ONE of sections A/B/C depending on your authentication model, then
   run section D (schema-level grants) and, if needed, section E
   (server-level grants for optional diagnostics) separately — E requires
   a server-level administrator and should be reviewed line-by-line before
   granting, since VIEW SERVER STATE exposes instance-wide (not just this
   database's) session/query text to the account.
   ========================================================================= */

-- -------------------------------------------------------------------------
-- SECTION A: SQL Server Authentication (on-prem / IaaS SQL Server)
-- -------------------------------------------------------------------------
USE [master];
GO

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'mcp_code_review')
BEGIN
    CREATE LOGIN [mcp_code_review]
        WITH PASSWORD = N'<REPLACE_WITH_A_STRONG_GENERATED_PASSWORD>',
        CHECK_POLICY = ON,
        CHECK_EXPIRATION = ON;
END
GO

-- Explicitly ensure no server-wide roles are attached (defensive, in case
-- the login already existed with elevated membership).
-- EXEC sp_dropsrvrolemember 'mcp_code_review', 'sysadmin';   -- run only if needed
-- EXEC sp_dropsrvrolemember 'mcp_code_review', 'serveradmin'; -- run only if needed


-- -------------------------------------------------------------------------
-- SECTION B: Windows Authentication (on-prem, domain-joined SQL Server)
-- -------------------------------------------------------------------------
-- USE [master];
-- GO
-- IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'DOMAIN\mcp_code_review')
-- BEGIN
--     CREATE LOGIN [DOMAIN\mcp_code_review] FROM WINDOWS;
-- END
-- GO
-- Set SQLSERVER_USE_WINDOWS_AUTH=true and run the MCP process under this
-- Windows identity (or use a gMSA), since Windows auth is tied to the
-- OS process/session, not a password in .env.


-- -------------------------------------------------------------------------
-- SECTION C: Azure SQL Database with Microsoft Entra ID (Azure AD)
-- -------------------------------------------------------------------------
-- Connect to the target database (not master) as an Entra ID admin, then:
--
-- CREATE USER [mcp_code_review] FROM EXTERNAL PROVIDER;
--
-- There is no server-level login step in Azure SQL Database; the contained
-- database user IS the principal. Server-level DMVs such as
-- sys.dm_os_wait_stats and sys.dm_io_virtual_file_stats are NOT available
-- in Azure SQL Database the same way as on-prem — see README "Required SQL
-- Server permissions" for the Azure SQL equivalents
-- (sys.dm_db_wait_stats, sys.dm_db_resource_stats, Query Store which is
-- always-on in Azure SQL Database).
-- Set SQLSERVER_USE_AZURE_AD=true.


-- -------------------------------------------------------------------------
-- SECTION D: Database-level user + minimum required permissions
-- Run this against the TARGET APPLICATION DATABASE (not master).
-- -------------------------------------------------------------------------
USE [<REPLACE_WITH_TARGET_DATABASE>];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'mcp_code_review')
BEGIN
    CREATE USER [mcp_code_review] FOR LOGIN [mcp_code_review];
END
GO

-- Metadata / schema discovery: built-in fixed database role, read-only by
-- design (can view schema/object metadata, cannot read or write table data
-- on its own).
ALTER ROLE [db_denydatawriter] ADD MEMBER [mcp_code_review];  -- belt-and-suspenders: explicit deny of writes
GO

-- If the review needs to read actual application data (e.g. for anything
-- beyond metadata), grant db_datareader explicitly and deliberately. Many
-- reviews only need metadata + Query Store + plans and can skip this.
-- ALTER ROLE [db_datareader] ADD MEMBER [mcp_code_review];
-- GO

-- View definitions of procedures/views/functions (needed for
-- sqlserver.get_procedure_definition). Grants read of object DEFINITIONS
-- only, never data.
GRANT VIEW DEFINITION TO [mcp_code_review];
GO

-- Query Store metadata is exposed via catalog views under normal SELECT
-- permission on the database; no extra grant is required beyond being a
-- user in the database with VIEW DATABASE STATE (see below) for some
-- server versions, or simply db_datareader-equivalent visibility on the
-- catalog views themselves (catalog views generally only show objects the
-- principal can already see).
GRANT VIEW DATABASE STATE TO [mcp_code_review];
GO

-- Optional: required by sqlserver.get_estimated_plan for queries referencing
-- objects in this database. Also grant SELECT on each referenced table/view
-- deliberately; SHOWPLAN does not replace permission to run the query.
-- GRANT SHOWPLAN TO [mcp_code_review];
-- GRANT SELECT ON OBJECT::[dbo].[<REVIEW_TABLE>] TO [mcp_code_review];
-- GO

-- Explicit, defensive denies (some of these are redundant with not being
-- granted in the first place, but they make intent unambiguous to future
-- auditors and survive accidental role membership changes).
DENY INSERT, UPDATE, DELETE, EXECUTE ON DATABASE::[<REPLACE_WITH_TARGET_DATABASE>] TO [mcp_code_review];
DENY ALTER, CONTROL, TAKE OWNERSHIP ON DATABASE::[<REPLACE_WITH_TARGET_DATABASE>] TO [mcp_code_review];
GO


-- -------------------------------------------------------------------------
-- SECTION E: OPTIONAL server-level grants for instance-wide diagnostics
-- Requires a server-level administrator. Review before running: this
-- exposes session state and SQL text for the WHOLE INSTANCE, not just
-- this application's database, to whatever tool holds this credential.
-- -------------------------------------------------------------------------
-- USE [master];
-- GO
-- GRANT VIEW SERVER STATE TO [mcp_code_review];
-- GO
--
-- Enables (see README "Required SQL Server permissions" for exact DMV
-- mapping):
--   sqlserver.get_wait_stats
--   sqlserver.get_missing_index_stats
--   sqlserver.get_io_stats
--   sqlserver.get_blocking_summary
--   sqlserver.get_active_expensive_queries
--   index usage counters inside sqlserver.get_indexes
--
-- If VIEW SERVER STATE cannot be granted (common in shared/managed
-- environments), the MCP still works — capability detection marks these
-- tools as unavailable and every other tool continues to function.


-- -------------------------------------------------------------------------
-- Cleanup / revocation (for decommissioning the account)
-- -------------------------------------------------------------------------
-- USE [<REPLACE_WITH_TARGET_DATABASE>];
-- DROP USER [mcp_code_review];
-- USE [master];
-- DROP LOGIN [mcp_code_review];
