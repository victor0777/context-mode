#!/usr/bin/env node
/**
 * No-secret ctx_api_probe savings smoke.
 *
 * The script verifies the same savings boundary as ctx_api_probe: a large raw
 * HTTP response is read locally, while only compact status/bytes/selected
 * evidence is emitted. It defaults to an in-process fixture server so CI and
 * contributors do not need internal network access.
 */

import http from "node:http";
import { Buffer } from "node:buffer";

const DEFAULT_SELECT = ["items.0.id", "items.0.status", "meta.total"];
const DEFAULT_MIN_RATIO = 5;
const DEFAULT_MIN_AVOIDED = 8 * 1024;

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} must be valid JSON: ${err.message}`);
  }
}

function readPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((cur, key) => {
    if (cur == null) return undefined;
    return cur[key];
  }, obj);
}

function makeFixturePayload() {
  return {
    meta: {
      total: 400,
      generated_by: "ctx-api-probe-savings-smoke",
    },
    items: Array.from({ length: 400 }, (_, index) => ({
      id: `item-${String(index).padStart(4, "0")}`,
      status: index % 3 === 0 ? "ready" : "queued",
      title: `Synthetic collaboration record ${index}`,
      description: "x".repeat(180),
      audit: {
        actor: `user-${index % 17}`,
        trace: "y".repeat(120),
      },
    })),
  };
}

function startFixtureServer() {
  const payload = JSON.stringify(makeFixturePayload());
  const server = http.createServer((req, res) => {
    if (req.url !== "/fixture") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(payload);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("fixture server did not expose a TCP address"));
        return;
      }
      resolve({
        close: () => new Promise((res) => server.close(res)),
        url: `http://127.0.0.1:${addr.port}/fixture`,
      });
    });
  });
}

async function compactProbe({ url, method, headers, body, select }) {
  const started = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body,
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const output = {
    url,
    method,
    status: response.status,
    content_type: contentType,
    bytes: Buffer.byteLength(text),
    elapsed_ms: Date.now() - started,
    selected: {},
    excerpt: "",
  };

  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      const parsed = JSON.parse(text);
      for (const path of select) output.selected[path] = readPath(parsed, path);
      if (select.length === 0) output.excerpt = JSON.stringify(parsed).slice(0, 1000);
    } catch {
      output.excerpt = text.slice(0, 1000);
    }
  } else {
    output.excerpt = text.slice(0, 1000);
  }

  const compact = JSON.stringify(output, null, 2);
  return {
    rawBytes: output.bytes,
    returnedBytes: Buffer.byteLength(compact),
    avoidedBytes: Math.max(0, output.bytes - Buffer.byteLength(compact)),
    ratio: output.bytes / Math.max(Buffer.byteLength(compact), 1),
    status: output.status,
    selectedCount: Object.keys(output.selected).length,
  };
}

function printUsage() {
  console.log(`Usage: node scripts/ctx-api-probe-savings-smoke.mjs

Environment:
  CM_SMOKE_URL          Optional target URL. Defaults to a local fixture server.
  CM_SMOKE_METHOD       HTTP method. Defaults to GET.
  CM_SMOKE_HEADERS_JSON Optional JSON object of headers. Never printed.
  CM_SMOKE_BODY         Optional request body.
  CM_SMOKE_SELECT_JSON  Optional JSON array of selected paths.
  CM_SMOKE_MIN_RATIO    Minimum raw/compact ratio. Defaults to ${DEFAULT_MIN_RATIO}.
  CM_SMOKE_MIN_AVOIDED  Minimum avoided bytes. Defaults to ${DEFAULT_MIN_AVOIDED}.

The script prints only status, byte counts, ratio, and pass/fail.`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  let fixture;
  const urlFromEnv = process.env.CM_SMOKE_URL;
  const url = urlFromEnv || (fixture = await startFixtureServer()).url;
  const method = process.env.CM_SMOKE_METHOD || "GET";
  const headers = parseJsonEnv("CM_SMOKE_HEADERS_JSON", {});
  const body = process.env.CM_SMOKE_BODY;
  const select = parseJsonEnv("CM_SMOKE_SELECT_JSON", DEFAULT_SELECT);
  const minRatio = Number(process.env.CM_SMOKE_MIN_RATIO || DEFAULT_MIN_RATIO);
  const minAvoided = Number(process.env.CM_SMOKE_MIN_AVOIDED || DEFAULT_MIN_AVOIDED);

  try {
    const result = await compactProbe({ url, method, headers, body, select });
    const pass = result.status >= 200
      && result.status < 400
      && result.avoidedBytes >= minAvoided
      && result.ratio >= minRatio
      && result.selectedCount === select.length;

    const summary = {
      status: result.status,
      raw_bytes: result.rawBytes,
      returned_bytes: result.returnedBytes,
      avoided_bytes: result.avoidedBytes,
      raw_to_compact_ratio: Number(result.ratio.toFixed(1)),
      selected_paths: result.selectedCount,
      min_ratio: minRatio,
      min_avoided_bytes: minAvoided,
      target: urlFromEnv ? "external" : "local-fixture",
    };

    console.log(pass ? "ctx_api_probe savings smoke: PASS" : "ctx_api_probe savings smoke: FAIL");
    console.log(JSON.stringify(summary, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    if (fixture) await fixture.close();
  }
}

main().catch((err) => {
  console.error(`ctx_api_probe savings smoke: FATAL ${err.message}`);
  process.exit(2);
});
