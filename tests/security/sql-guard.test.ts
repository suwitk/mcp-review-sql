import { describe, it, expect } from "vitest";
import { assertSafeSelect } from "../../src/security/sql-guard.js";
import { McpToolError } from "../../src/types/index.js";

function expectUnsafe(sql: string) {
  try {
    assertSafeSelect(sql);
    throw new Error(`Expected sql to be rejected but it was accepted: ${sql}`);
  } catch (err) {
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toMatch(/UNSAFE_QUERY|INVALID_INPUT/);
  }
}

function expectSafe(sql: string) {
  const result = assertSafeSelect(sql);
  expect(result.ok).toBe(true);
}

describe("sql-guard: rejects dangerous statements", () => {
  it("rejects DELETE", () => {
    expectUnsafe("DELETE FROM Orders;");
  });

  it("rejects DROP TABLE", () => {
    expectUnsafe("DROP TABLE Orders;");
  });

  it("rejects sp_configure", () => {
    expectUnsafe("EXEC sp_configure 'show advanced options', 1;");
  });

  it("rejects a SELECT followed by a second batch containing DROP TABLE", () => {
    expectUnsafe("SELECT * FROM Orders;\nDROP TABLE Orders;");
  });

  it("rejects WITH ... DELETE", () => {
    expectUnsafe(
      "WITH x AS (SELECT id FROM Orders) DELETE FROM x WHERE id = 1;"
    );
  });

  it("rejects INSERT", () => {
    expectUnsafe("INSERT INTO Orders (id) VALUES (1);");
  });

  it("rejects UPDATE", () => {
    expectUnsafe("UPDATE Orders SET status = 'x';");
  });

  it("rejects MERGE", () => {
    expectUnsafe("MERGE INTO Orders USING Staging ON Orders.id = Staging.id WHEN MATCHED THEN UPDATE SET Orders.status = Staging.status;");
  });

  it("rejects TRUNCATE", () => {
    expectUnsafe("TRUNCATE TABLE Orders;");
  });

  it("rejects ALTER", () => {
    expectUnsafe("ALTER TABLE Orders ADD COLUMN x INT;");
  });

  it("rejects CREATE", () => {
    expectUnsafe("CREATE TABLE Foo (id INT);");
  });

  it("rejects GRANT/REVOKE/DENY", () => {
    expectUnsafe("GRANT SELECT ON Orders TO public;");
    expectUnsafe("REVOKE SELECT ON Orders FROM public;");
    expectUnsafe("DENY SELECT ON Orders TO public;");
  });

  it("rejects BACKUP/RESTORE", () => {
    expectUnsafe("BACKUP DATABASE Foo TO DISK = 'x';");
    expectUnsafe("RESTORE DATABASE Foo FROM DISK = 'x';");
  });

  it("rejects DBCC and SHUTDOWN", () => {
    expectUnsafe("DBCC CHECKDB('Foo');");
    expectUnsafe("SHUTDOWN;");
  });

  it("rejects xp_cmdshell", () => {
    expectUnsafe("EXEC xp_cmdshell 'dir';");
  });

  it("rejects EXEC of an arbitrary stored procedure", () => {
    expectUnsafe("EXEC dbo.SearchOrders @keyword = 'abc';");
  });

  it("rejects SELECT ... INTO (creates a table)", () => {
    expectUnsafe("SELECT * INTO NewTable FROM Orders;");
  });

  it("rejects OPENROWSET", () => {
    expectUnsafe("SELECT * FROM OPENROWSET('SQLNCLI', 'server';'user';'pw', 'SELECT 1');");
  });
});

describe("sql-guard: bypass attempts", () => {
  it("rejects mixed-case DROP", () => {
    expectUnsafe("dRoP TaBlE Orders;");
  });

  it("rejects DELETE hidden after a line comment", () => {
    expectUnsafe("-- innocent comment\nDELETE FROM Orders;");
  });

  it("rejects DELETE hidden after a block comment", () => {
    expectUnsafe("/* just checking things */ DELETE FROM Orders;");
  });

  it("does not trigger on banned keywords that only appear inside string literals", () => {
    expectSafe("SELECT * FROM Orders WHERE description = 'please DROP TABLE nothing, this is just text';");
  });

  it("does not trigger on banned keywords appearing inside a comment within an otherwise-safe SELECT", () => {
    expectSafe("SELECT id /* DELETE FROM Orders */ FROM Orders;");
  });

  it("rejects semicolon-separated batches even with extra whitespace/newlines", () => {
    expectUnsafe("SELECT 1;\n\n   DROP   TABLE   Orders  ;");
  });

  it("rejects statements attempting to bypass guards via nested parens across batches", () => {
    expectUnsafe("SELECT 1 FROM (SELECT 1 AS x) t; DELETE FROM Orders WHERE 1=1;");
  });
});

describe("sql-guard: allows legitimate read-only queries", () => {
  it("allows a simple SELECT", () => {
    expectSafe("SELECT * FROM Orders WHERE Id = @id;");
  });

  it("allows a CTE SELECT", () => {
    expectSafe(
      "WITH RecentOrders AS (SELECT * FROM Orders WHERE CreatedAt > @since) SELECT * FROM RecentOrders;"
    );
  });

  it("allows a nested subquery SELECT", () => {
    expectSafe(
      "SELECT * FROM Orders WHERE CustomerId IN (SELECT Id FROM Customers WHERE Country = 'TH');"
    );
  });

  it("allows lowercase select", () => {
    expectSafe("select top 10 * from Orders;");
  });

  it("allows a trailing semicolon with trailing whitespace", () => {
    expectSafe("SELECT 1;   \n  ");
  });

  it("allows SELECT with a comment inside it", () => {
    expectSafe("SELECT id -- primary key\nFROM Orders;");
  });
});

describe("sql-guard: invalid input", () => {
  it("rejects empty string", () => {
    expectUnsafe("");
  });

  it("rejects whitespace-only string", () => {
    expectUnsafe("   \n\t  ");
  });

  it("rejects a comment-only statement", () => {
    expectUnsafe("-- just a comment, no statement");
  });
});
