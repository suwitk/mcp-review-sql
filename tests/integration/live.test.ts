import { describe, it, expect } from "vitest";

/**
 * These tests only run against a real SQL Server instance when explicitly
 * enabled (see tests/integration/README.md). They are skipped by default
 * so `npm test` never depends on network access.
 */
const RUN = process.env.RUN_INTEGRATION_TESTS === "true";

describe.skipIf(!RUN)("live SQL Server integration", () => {
  it("connects and reads database info", async () => {
    const { loadConfig } = await import("../../src/config/index.js");
    const { getDatabaseInfo } = await import("../../src/tools/database-info.js");
    const { detectCapabilities } = await import("../../src/db/capabilities.js");

    const config = loadConfig();
    const capabilities = await detectCapabilities(config);
    const info = await getDatabaseInfo(config, capabilities);

    expect(info.database).toBeTruthy();
    expect(typeof info.compatibilityLevel).toBe("number");
  });

  it("rejects a write attempted directly through the driver (real boundary check)", async () => {
    const { loadConfig } = await import("../../src/config/index.js");
    const { runQuery } = await import("../../src/db/query.js");
    const config = loadConfig();

    await expect(
      runQuery(config, "UPDATE sys.objects SET name = name WHERE 1 = 0")
    ).rejects.toThrow();
  });

  it("returns an estimated plan", async () => {
    const { loadConfig } = await import("../../src/config/index.js");
    const { getEstimatedPlan } = await import("../../src/tools/execution-plan.js");
    const plan = await getEstimatedPlan(loadConfig(), { sql: "SELECT DB_NAME()", includeRawXml: false });
    expect(plan.operators).toBeDefined();
  });
});
