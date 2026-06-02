import "./../setup-home";

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(here, "..", "..", "scripts", "ctx-api-probe-savings-smoke.mjs");

function runSmoke(env: Record<string, string> = {}) {
  const result = spawnSync("node", [SCRIPT], {
    encoding: "utf-8",
    env: {
      ...process.env,
      ...env,
    },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("ctx-api-probe-savings-smoke.mjs", () => {
  it("passes against the local no-secret fixture", () => {
    const result = runSmoke();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ctx_api_probe savings smoke: PASS");
    expect(result.stdout).toContain('"target": "local-fixture"');
    expect(result.stdout).toMatch(/"avoided_bytes":\s*[1-9]\d+/);
  });

  it("fails when the required compression ratio is intentionally impossible", () => {
    const result = runSmoke({ CM_SMOKE_MIN_RATIO: "100000" });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("ctx_api_probe savings smoke: FAIL");
  });

  it("does not print supplied headers or request body", () => {
    const result = runSmoke({
      CM_SMOKE_METHOD: "POST",
      CM_SMOKE_HEADERS_JSON: JSON.stringify({
        Authorization: "Bearer super-secret-token",
        Cookie: "session=private-cookie",
      }),
      CM_SMOKE_BODY: "private-request-body",
    });

    expect(result.stdout + result.stderr).not.toContain("super-secret-token");
    expect(result.stdout + result.stderr).not.toContain("private-cookie");
    expect(result.stdout + result.stderr).not.toContain("private-request-body");
  });
});
