import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runQuery } from "../../src/db/query.js";
import { getPool } from "../../src/db/pool.js";
import type { AppConfig } from "../../src/config/index.js";

vi.mock("../../src/db/pool.js", () => ({ getPool: vi.fn() }));

class FakeRequest extends EventEmitter {
  stream = false;
  canceled = false;
  input() { return this; }
  cancel() {
    this.canceled = true;
    this.emit("error", Object.assign(new Error("Canceled."), { code: "ECANCEL" }));
    this.emit("done", {});
  }
  async query() {
    queueMicrotask(() => {
      for (let i = 1; i <= 10 && !this.canceled; i++) this.emit("row", { id: i });
      if (!this.canceled) this.emit("done", {});
    });
    return { recordset: [], rowsAffected: [] };
  }
}

describe("streamed row limit", () => {
  it("cancels on the first extra row and returns only the cap", async () => {
    const request = new FakeRequest();
    vi.mocked(getPool).mockResolvedValue({ request: () => request } as never);
    const config = { db: { queryTimeoutMs: 15000 } } as AppConfig;
    const result = await runQuery<{ id: number }>(config, "SELECT id FROM dbo.T", {}, { maxRows: 2 });
    expect(request.stream).toBe(true);
    expect(request.canceled).toBe(true);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.truncated).toBe(true);
  });
});
