import { describe, it, expect } from "vitest";
import { isSensitiveColumn, redactRows } from "../../src/security/redaction.js";
import type { AppConfig } from "../../src/config/index.js";

function fakeConfig(patterns: string[]): AppConfig {
  return {
    db: {} as AppConfig["db"],
    limits: {} as AppConfig["limits"],
    logging: {} as AppConfig["logging"],
    redaction: { columnPatterns: patterns },
  };
}

describe("redaction", () => {
  it("flags known sensitive column name substrings", () => {
    expect(isSensitiveColumn("PasswordHash", ["password"])).toBe(true);
    expect(isSensitiveColumn("user_ssn", ["ssn"])).toBe(true);
    expect(isSensitiveColumn("email", ["password", "ssn"])).toBe(false);
  });

  it("redacts matching column values but leaves others untouched", () => {
    const rows = [
      { id: 1, email: "a@example.com", password_hash: "abc123" },
      { id: 2, email: "b@example.com", password_hash: "def456" },
    ];
    const redacted = redactRows(rows, fakeConfig(["password"]));
    expect(redacted[0]?.password_hash).toBe("***REDACTED***");
    expect(redacted[1]?.password_hash).toBe("***REDACTED***");
    expect(redacted[0]?.email).toBe("a@example.com");
    expect(redacted[0]?.id).toBe(1);
  });

  it("is a no-op when there are no patterns configured", () => {
    const rows = [{ password: "x" }];
    expect(redactRows(rows, fakeConfig([]))).toEqual(rows);
  });

  it("is a no-op on an empty result set", () => {
    expect(redactRows([], fakeConfig(["password"]))).toEqual([]);
  });
});
