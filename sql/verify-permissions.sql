/* =========================================================================
   sqlserver-review-mcp — verify-permissions.sql

   Run as the mcp_code_review login (or impersonate it) to confirm:
     1. It CANNOT write.
     2. It CAN read the metadata this MCP needs.
     3. Which optional diagnostics are available (mirrors the MCP's own
        startup capability detection in src/db/capabilities.ts).

   Safe to run repeatedly; performs no writes.
   ========================================================================= */

USE [<REPLACE_WITH_TARGET_DATABASE>];
GO

PRINT '--- Current principal ---';
SELECT SUSER_SNAME() AS loginName, USER_NAME() AS databaseUser;
GO

PRINT '--- 1. Write attempts MUST fail (each statement below should error) ---';

BEGIN TRY
    -- Pick any real table name to test against; expect a permission error.
    EXEC sp_executesql N'UPDATE sys.objects SET name = name WHERE 1 = 0';
    PRINT 'FAIL: write did not error (unexpected)';
END TRY
BEGIN CATCH
    PRINT 'OK: write correctly denied -> ' + ERROR_MESSAGE();
END CATCH
GO

PRINT '--- 2. Required read-only metadata access ---';

BEGIN TRY
    SELECT TOP (1) name FROM sys.tables;
    PRINT 'OK: can read sys.tables';
END TRY
BEGIN CATCH
    PRINT 'FAIL: cannot read sys.tables -> ' + ERROR_MESSAGE();
END CATCH
GO

BEGIN TRY
    SELECT TOP (1) OBJECT_DEFINITION(object_id) FROM sys.objects WHERE type = 'P';
    PRINT 'OK: VIEW DEFINITION works (or no procedures exist)';
END TRY
BEGIN CATCH
    PRINT 'INFO: VIEW DEFINITION unavailable -> ' + ERROR_MESSAGE();
END CATCH
GO

PRINT '--- 3. Optional diagnostics capability probes ---';

BEGIN TRY
    SELECT TOP (1) actual_state_desc FROM sys.database_query_store_options;
    PRINT 'OK: Query Store catalog view readable';
END TRY
BEGIN CATCH
    PRINT 'INFO: Query Store unavailable -> ' + ERROR_MESSAGE();
END CATCH
GO

BEGIN TRY
    SELECT TOP (1) wait_type FROM sys.dm_os_wait_stats;
    PRINT 'OK: VIEW SERVER STATE / wait stats readable';
END TRY
BEGIN CATCH
    PRINT 'INFO: wait stats unavailable (VIEW SERVER STATE not granted) -> ' + ERROR_MESSAGE();
END CATCH
GO

BEGIN TRY
    SELECT TOP (1) database_id FROM sys.dm_db_missing_index_details;
    PRINT 'OK: missing-index DMVs readable';
END TRY
BEGIN CATCH
    PRINT 'INFO: missing-index DMVs unavailable -> ' + ERROR_MESSAGE();
END CATCH
GO

BEGIN TRY
    SELECT TOP (1) database_id FROM sys.dm_io_virtual_file_stats(DB_ID(), NULL);
    PRINT 'OK: IO virtual file stats readable';
END TRY
BEGIN CATCH
    PRINT 'INFO: IO stats unavailable -> ' + ERROR_MESSAGE();
END CATCH
GO

PRINT '--- Effective role memberships (review for anything unexpected) ---';
SELECT dp2.name AS roleName
FROM sys.database_role_members drm
JOIN sys.database_principals dp1 ON dp1.principal_id = drm.member_principal_id
JOIN sys.database_principals dp2 ON dp2.principal_id = drm.role_principal_id
WHERE dp1.name = 'mcp_code_review';
GO
