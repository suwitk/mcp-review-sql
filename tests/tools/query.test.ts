import { describe, it, expect } from "vitest";
import { executeSelectInput } from "../../src/tools/query.js";

describe("executeSelectInput schema", () => {
  it("accepts a minimal valid request", () => {
    const parsed = executeSelectInput.parse({ sql: "SELECT 1" });
    expect(parsed.sql).toBe("SELECT 1");
  });

  it("accepts parameters and maxRows", () => {
    const parsed = executeSelectInput.parse({
      sql: "SELECT * FROM Orders WHERE Id = @id",
      parameters: { id: 5 },
      maxRows: 10,
    });
    expect(parsed.parameters?.id).toBe(5);
    expect(parsed.maxRows).toBe(10);
  });

  it("rejects an empty sql string", () => {
    expect(() => executeSelectInput.parse({ sql: "" })).toThrow();
  });

  it("rejects a non-object parameter value", () => {
    expect(() =>
      executeSelectInput.parse({ sql: "SELECT 1", parameters: { id: { nested: true } } })
    ).toThrow();
  });
});
