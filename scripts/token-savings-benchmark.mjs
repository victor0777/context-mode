#!/usr/bin/env node
/**
 * Deterministic token-savings benchmark.
 *
 * This is intentionally tool-boundary oriented instead of a full MCP session:
 * it measures representative raw payloads and the compact outputs that
 * context-mode-style workflows should return to the model.
 */

import { Buffer } from "node:buffer";

const DEFAULT_MIN_RATIO = 5;

function bytes(text) {
  return Buffer.byteLength(String(text));
}

function ratio(rawBytes, returnedBytes) {
  return rawBytes / Math.max(returnedBytes, 1);
}

function makeLargeJson() {
  return JSON.stringify({
    meta: { total: 500, source: "token-savings-benchmark" },
    items: Array.from({ length: 500 }, (_, index) => ({
      id: `rec-${String(index).padStart(4, "0")}`,
      status: index % 4 === 0 ? "ready" : "queued",
      title: `Synthetic record ${index}`,
      body: "x".repeat(220),
      trace: "y".repeat(160),
    })),
  });
}

function compactJsonProbe(raw) {
  const parsed = JSON.parse(raw);
  return JSON.stringify({
    status: 200,
    bytes: bytes(raw),
    selected: {
      "items.0.id": parsed.items[0].id,
      "items.0.status": parsed.items[0].status,
      "meta.total": parsed.meta.total,
    },
  });
}

function runScenarios() {
  const noisyShellRaw = Array.from({ length: 900 }, (_, i) =>
    `line=${i} status=${i % 7 === 0 ? "WARN" : "OK"} value=${String(i * 13).padStart(6, "0")}`,
  ).join("\n");
  const noisyShellReturned = JSON.stringify({
    lines: 900,
    warnings: 129,
    max_value: 11687,
  });

  const largeFileRaw = Array.from({ length: 1200 }, (_, i) =>
    JSON.stringify({ id: i, type: i % 5 === 0 ? "error" : "event", message: "z".repeat(120) }),
  ).join("\n");
  const largeFileReturned = JSON.stringify({
    records: 1200,
    errors: 240,
    summary: "Parsed synthetic log and counted error records.",
  });

  const batchRaw = [
    "git files\n" + Array.from({ length: 600 }, (_, i) => `src/module-${i}.ts`).join("\n"),
    "test failures\n" + Array.from({ length: 300 }, (_, i) => `PASS test-${i}`).join("\n"),
    "todo search\n" + Array.from({ length: 200 }, (_, i) => `TODO item ${i}`).join("\n"),
  ].join("\n---\n");
  const batchReturned = JSON.stringify({
    files: 600,
    passing_tests: 300,
    todos: 200,
  });

  const apiRaw = makeLargeJson();
  const apiReturned = compactJsonProbe(apiRaw);

  const indexedCorpusRaw = Array.from({ length: 300 }, (_, i) =>
    `# Section ${i}\nThis documentation paragraph contains synthetic indexed content ${"q".repeat(180)}.`,
  ).join("\n\n");
  const searchReturned = JSON.stringify({
    query: "synthetic indexed content",
    snippets: [
      "Section 0: This documentation paragraph contains synthetic indexed content...",
      "Section 17: This documentation paragraph contains synthetic indexed content...",
      "Section 42: This documentation paragraph contains synthetic indexed content...",
    ],
  });

  return [
    {
      tool: "ctx_execute",
      class: "noisy-command",
      minRatio: 10,
      raw: noisyShellRaw,
      returned: noisyShellReturned,
    },
    {
      tool: "ctx_execute_file",
      class: "large-file",
      minRatio: 10,
      raw: largeFileRaw,
      returned: largeFileReturned,
    },
    {
      tool: "ctx_batch_execute",
      class: "multi-command",
      minRatio: 10,
      raw: batchRaw,
      returned: batchReturned,
    },
    {
      tool: "ctx_api_probe",
      class: "large-json-api",
      minRatio: 5,
      raw: apiRaw,
      returned: apiReturned,
    },
    {
      tool: "ctx_search",
      class: "indexed-snippets",
      minRatio: 3,
      raw: indexedCorpusRaw,
      returned: searchReturned,
    },
  ].map((scenario) => {
    const rawBytes = bytes(scenario.raw);
    const returnedBytes = bytes(scenario.returned);
    const avoidedBytes = Math.max(0, rawBytes - returnedBytes);
    const rawToReturned = ratio(rawBytes, returnedBytes);
    return {
      tool: scenario.tool,
      class: scenario.class,
      raw_bytes: rawBytes,
      returned_bytes: returnedBytes,
      avoided_bytes: avoidedBytes,
      raw_to_returned_ratio: Number(rawToReturned.toFixed(1)),
      min_ratio: scenario.minRatio,
      pass: rawToReturned >= scenario.minRatio && avoidedBytes > 0,
    };
  });
}

function printUsage() {
  console.log(`Usage: node scripts/token-savings-benchmark.mjs [--json]

Runs a deterministic local benchmark for representative context-mode workflow
classes. No external network or secrets are used.`);
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  const rows = runScenarios();
  const totalRaw = rows.reduce((sum, row) => sum + row.raw_bytes, 0);
  const totalReturned = rows.reduce((sum, row) => sum + row.returned_bytes, 0);
  const totalAvoided = rows.reduce((sum, row) => sum + row.avoided_bytes, 0);
  const summary = {
    status: rows.every((row) => row.pass) ? "pass" : "fail",
    total_raw_bytes: totalRaw,
    total_returned_bytes: totalReturned,
    total_avoided_bytes: totalAvoided,
    total_ratio: Number(ratio(totalRaw, totalReturned).toFixed(1)),
    default_min_ratio: DEFAULT_MIN_RATIO,
    scenarios: rows,
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`token savings benchmark: ${summary.status.toUpperCase()}`);
    for (const row of rows) {
      console.log(
        `${row.tool.padEnd(18)} ${String(row.raw_bytes).padStart(8)} raw  ${String(row.returned_bytes).padStart(6)} returned  ${String(row.avoided_bytes).padStart(8)} avoided  ${String(row.raw_to_returned_ratio).padStart(6)}x  ${row.pass ? "PASS" : "FAIL"}`,
      );
    }
    console.log(
      `total ${summary.total_raw_bytes} raw  ${summary.total_returned_bytes} returned  ${summary.total_avoided_bytes} avoided  ${summary.total_ratio}x`,
    );
  }

  if (summary.status !== "pass") process.exitCode = 1;
}

main();
