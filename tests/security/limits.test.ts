import { describe, it, expect } from "vitest";
import { clampMaxRows, truncateText, noteRowLimitExceeded } from "../../src/security/limits.js";
import { McpToolError } from "../../src/types/index.js";
import type { AppConfig } from "../../src/config/index.js";

function fakeConfig(defaultRows: number, maxRows: number): AppConfig {
  return {
    db: {} as AppConfig["db"],
    limits: { defaultRows, maxRows, maxQueryTextChars: 8000, maxPlanXmlChars: 200000 },
    logging: {} as AppConfig["logging"],
    redaction: { columnPatterns: [] },
  };
}

describe("limits", () => {
  it("uses the configured default when no maxRows is requested", () => {
    expect(clampMaxRows(undefined, fakeConfig(100, 1000))).toBe(100);
  });

  it("clamps a caller-requested value to the global maximum", () => {
    expect(clampMaxRows(5000, fakeConfig(100, 1000))).toBe(1000);
  });

  it("allows a caller-requested value under the maximum", () => {
    expect(clampMaxRows(50, fakeConfig(100, 1000))).toBe(50);
  });

  it("rejects a non-positive maxRows", () => {
    expect(() => clampMaxRows(0, fakeConfig(100, 1000))).toThrow(McpToolError);
    expect(() => clampMaxRows(-5, fakeConfig(100, 1000))).toThrow(McpToolError);
  });

  it("truncates long text and reports truncation", () => {
    const { text, truncated } = truncateText("a".repeat(100), 10);
    expect(truncated).toBe(true);
    expect(text.startsWith("a".repeat(10))).toBe(true);
  });

  it("does not truncate text under the limit", () => {
    const { text, truncated } = truncateText("short", 100);
    expect(truncated).toBe(false);
    expect(text).toBe("short");
  });

  it("notes when the row cap was hit", () => {
    expect(noteRowLimitExceeded(100, 100)).toBeDefined();
    expect(noteRowLimitExceeded(5, 100)).toBeUndefined();
  });
});
