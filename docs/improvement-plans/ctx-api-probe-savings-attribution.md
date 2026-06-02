# ctx_api_probe Savings Attribution Follow-up Plan

## Context

The first improvement pass added compact internal API probing through
`ctx_api_probe`. The direction is correct for token reduction: the tool fetches
the full HTTP response inside the sandbox and returns only compact evidence
such as status, content type, response byte count, selected JSON paths, and a
short excerpt.

The first attribution gap has been fixed. The compact response keeps raw API
bodies out of the model context, and `ctx_api_probe` now emits a real-bytes
`api-probe` session event with compact `bytesReturned` and avoided raw-response
bytes.

That means `ctx_stats` can show both that the model received fewer bytes and
that the raw API body was kept out of context.

## Current Evidence

- `ctx_api_probe` returns compact JSON with a `bytes` field measured from the
  fetched response body.
- `trackResponse()` records the compact tool response bytes in
  `sessionStats.bytesReturned`.
- `trackResponse()` now accepts `apiProbeResponseBytes` and emits an
  `api-probe` event for successful `ctx_api_probe` calls.
- `extractApiProbeResponseBytes()` reads only the compact output `bytes` field;
  it does not persist or index the full response body.
- `emitApiProbeEvent()` records:
  - `type: "api-probe"`
  - `category: "sandbox"`
  - `data: "ctx_api_probe"`
  - `bytesReturned`: compact output bytes
  - `bytesAvoided`: `max(0, responseBodyBytes - compactOutputBytes)`
- Existing targeted tests pass for `ctx_api_probe` schema, auth-header support,
  CA pass-through, SSRF guard coverage, redacted output, and stats report
  formatting.
- The earlier unrelated `ctx_index` path-resolution failures were fixed and
  `tests/core/server.test.ts` now passes as a full file.

## Improvement Items

### 1. Attribute avoided bytes for `ctx_api_probe` — implemented

**Goal**

Make `ctx_stats` reflect the actual savings from compact API probes.

**Implemented**

- Parses the compact probe JSON after the child process returns.
- Reads the response body byte count from the `bytes` field.
- Measures the compact output byte count that enters model context.
- Emits a session event with:
  - `toolName: "ctx_api_probe"`
  - `bytesReturned`: compact output bytes
  - `bytesAvoided`: `max(0, responseBodyBytes - compactOutputBytes)`
- Keeps the current redaction boundary before any output enters context.
- Does not index the response body.

**Touched**

- `src/server.ts`
- `src/session/event-emit.ts`
- `tests/core/server.test.ts`
- `tests/session/event-emit.test.ts`

**Acceptance criteria**

- `api-probe` session events increase `bytesAvoided` by raw response bytes minus
  compact output bytes.
- `ctx_stats` strict-compression percentage uses that avoided-byte signal via
  the existing `session_events.bytes_avoided/bytes_returned` aggregation.
- Auth headers and response excerpts remain redacted.
- The full response body is not persisted to the content index.

### 2. Add a raw-vs-compact benchmark fixture

**Goal**

Prove token savings with a stable, repeatable scenario instead of relying only
on session aggregate `ctx_stats`.

**Plan**

- Add a test fixture HTTP server that returns a large JSON body with a few known
  nested fields.
- Run `ctx_api_probe` with a small `select` list.
- Assert:
  - raw response bytes are above a meaningful threshold
  - returned compact bytes are below a fixed ceiling
  - selected JSON paths are present
  - the avoided-byte attribution matches the fixture size

**Likely touch points**

- `tests/core/server.test.ts` or a dedicated
  `tests/core/api-probe-savings.test.ts`
- Optional helper in `tests/helpers/` if the repo already has one for local
  HTTP fixtures

**Acceptance criteria**

- The fixture fails if `ctx_api_probe` starts echoing full response bodies.
- The fixture fails if avoided-byte attribution is removed or regresses.
- The fixture does not require external network access.

### 3. Surface per-tool savings in `ctx_stats`

**Status: implemented**

**Goal**

Make it easy to answer: "Did this specific tool save tokens?"

**Plan**

- Extend the per-tool breakdown to include avoided bytes where available.
- Ensure `ctx_api_probe` appears with calls, returned bytes, and avoided bytes.
- Keep the headline strict-compression formula unchanged:
  `1 - bytesReturned / (bytesAvoided + bytesReturned)`.

**Likely touch points**

- `src/session/analytics.ts`
- `src/server.ts`
- `tests/analytics/format-report.test.ts`

**Acceptance criteria**

- `ctx_stats` can show that `ctx_api_probe` returned a compact payload while
  avoiding a larger raw API response.
- Existing tools keep their current stats semantics.
- Event-data bytes stay out of the Section 1 strict-compression ratio.

### 4. Add a real collaboration API smoke recipe

**Status: implemented**

**Goal**

Give operators a safe manual check for internal API token savings without
recording secrets or dumping payloads.

**Smoke script**

Run the no-secret local fixture first:

```bash
npm run smoke:api-probe-savings
```

For an internal collaboration API endpoint, pass the URL, selected JSON paths,
and any secret headers through environment variables. The script never prints
headers, cookies, request bodies, or response bodies.

```bash
export COLLAB_API_TOKEN="replace-with-token-from-secret-store"
CM_SMOKE_URL="https://collaboration.example.internal/api/v1/items" \
CM_SMOKE_HEADERS_JSON="$(node -e 'process.stdout.write(JSON.stringify({Authorization:`Bearer ${process.env.COLLAB_API_TOKEN}`}))')" \
CM_SMOKE_SELECT_JSON='["items.0.id","items.0.status","meta.total"]' \
npm run smoke:api-probe-savings
```

For internal HTTPS endpoints with a private CA, run the real `ctx_api_probe`
operator check with the same `select` list and pass `ca_file` through the MCP
tool call. Keep tokens in the host environment; do not paste real values into
this repository or issue logs.

**Interpretation thresholds**

- Healthy compact API probe: raw response is at least 5x larger than compact
  returned output, and avoided bytes increase by at least several KB for a
  large JSON endpoint.
- Suspicious compact API probe: ratio is below 3x on a large endpoint, selected
  paths are missing, or returned bytes approach raw response bytes. Check
  whether the probe is echoing excerpts or selecting too much data.
- Expectedly low savings: tiny endpoints, exact-snippet retrieval, health
  checks, and intentionally detailed summaries may have low ratios without
  being regressions.
- Large file or log summarization should normally stay above 10x unless the
  user asked for detailed output.
- Indexed docs search may have lower apparent savings because it returns exact
  snippets; use the session-level strict-compression headline in `ctx_stats` as
  the source of truth for whole-session savings.

**Original manual plan**

- Document a smoke command using `ctx_api_probe` against the collaboration
  canonical API with a redacted auth header placeholder.
- Include a before/after check:
  - call `ctx_stats`
  - run one `ctx_api_probe` against a known large endpoint with `select`
  - call `ctx_stats` again
  - confirm `ctx_api_probe` shows compact returned bytes and avoided bytes

**Likely touch points**

- This document
- `README.md` utility-command examples, if the recipe should be user-facing

**Acceptance criteria**

- The recipe does not include real tokens, cookies, or secret host-specific
  credentials.
- The recipe works with internal CA support when `ca_file` is supplied.
- The recipe gives a clear yes/no signal for token-save attribution.

## Verification Plan

Run targeted checks first:

```bash
npx vitest run tests/scripts/ctx-api-probe-savings-smoke.test.ts tests/analytics/metrics.test.ts tests/analytics/format-report.test.ts
```

Then run the broader regression set:

```bash
npx vitest run tests/core/server.test.ts tests/executor.test.ts tests/analytics/format-report.test.ts
```

Finally run the normal package gates:

```bash
npm run typecheck
npm run build
```

## Review Notes

- The current implementation direction does save model-context bytes because it
  returns compact JSON instead of raw API bodies.
- Stats attribution and per-tool display are now covered. The remaining useful
  hardening item is a dedicated raw-vs-compact `ctx_api_probe` fixture test that
  exercises the MCP handler path directly.
