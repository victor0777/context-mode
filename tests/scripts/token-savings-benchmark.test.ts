import "./../setup-home";

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(here, "..", "..", "scripts", "token-savings-benchmark.mjs");

function runBenchmark(args: string[] = []) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf-8",
    env: process.env,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("token-savings-benchmark.mjs", () => {
  it("passes with deterministic local scenarios", () => {
    const result = runBenchmark();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("token savings benchmark: PASS");
    expect(result.stdout).toContain("ctx_execute");
    expect(result.stdout).toContain("ctx_execute_file");
    expect(result.stdout).toContain("ctx_batch_execute");
    expect(result.stdout).toContain("ctx_api_probe");
    expect(result.stdout).toContain("ctx_search");
  });

  it("emits auditable JSON totals and per-tool ratios", () => {
    const result = runBenchmark(["--json"]);
    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.status).toBe("pass");
    expect(parsed.total_raw_bytes).toBeGreaterThan(parsed.total_returned_bytes);
    expect(parsed.total_avoided_bytes).toBe(
      parsed.total_raw_bytes - parsed.total_returned_bytes,
    );
    expect(parsed.total_ratio).toBeGreaterThan(10);
    expect(parsed.scenarios).toHaveLength(5);

    for (const row of parsed.scenarios) {
      expect(row.pass).toBe(true);
      expect(row.raw_bytes).toBeGreaterThan(row.returned_bytes);
      expect(row.avoided_bytes).toBe(row.raw_bytes - row.returned_bytes);
      expect(row.raw_to_returned_ratio).toBeGreaterThanOrEqual(row.min_ratio);
    }
  });
});
