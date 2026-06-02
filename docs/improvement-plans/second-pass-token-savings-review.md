# Second-Pass Token Savings Review

## Context

This is a follow-up review after the `ctx_api_probe` compact API probe and
avoided-byte attribution work. The goal is to verify whether the changes save
model-context tokens as intended, then identify the next improvement items.

The core design is sound:

- `ctx_api_probe` fetches the full HTTP body inside the sandbox.
- The model receives only compact evidence: URL, method, status, content type,
  raw response byte count, elapsed time, selected JSON paths, and a short
  redacted excerpt when needed.
- `trackResponse()` records the compact tool response bytes.
- `extractApiProbeResponseBytes()` reads the compact `bytes` field and does
  not persist or index the raw HTTP body.
- `emitApiProbeEvent()` records real avoided bytes as:
  `max(0, rawResponseBytes - compactOutputBytes)`.

That means the runtime behavior should save context bytes whenever the raw
HTTP body is larger than the compact probe output. It also means the savings
are now attributable through session events, not just implied by smaller tool
output.

## Current Verification

Verification was re-run from `/data/shared_repo/codex/context-mode`:

```bash
npx vitest run tests/core/server.test.ts tests/session/event-emit.test.ts
npx vitest run tests/analytics/metrics.test.ts tests/analytics/format-report.test.ts
```

Observed result:

- `tests/session/event-emit.test.ts` passed.
- `tests/analytics/metrics.test.ts` and
  `tests/analytics/format-report.test.ts` passed after adding exact per-tool
  avoided-byte coverage.
- `tests/core/server.test.ts` now passes as a full file: 501 tests passed.
- Existing targeted checks in `tests/core/server.test.ts` passed for:
  - `redactSensitiveText`
  - persistent-index redaction paths
  - `extractApiProbeResponseBytes`
  - `ctx_api_probe` schema, auth headers, `ca_file`, SSRF guard, and redacted
    output
- The earlier `ctx_index` path-resolution failures were caused by Codex
  environment variables leaking into the JetBrains simulation path. The test
  environment now scrubs `CODEX_THREAD_ID` and `CODEX_CI` for that simulation.

## Evaluation

`ctx_api_probe` is saving tokens in the intended way at the tool boundary:

- The raw HTTP response stays inside the sandbox.
- Only compact JSON enters the model context.
- Avoided bytes are calculated from real response size, not from a fixed
  estimate.
- Secrets are redacted before output can enter context.

The remaining gap is mostly observability and regression coverage:

- The active-session per-tool breakdown now prefers exact
  `session_events.bytes_avoided` values when available, especially for
  `ctx_api_probe`. Tools without exact avoided-byte events still fall back to
  the previous global-ratio estimate.
- There is no dedicated raw-vs-compact fixture that fails if `ctx_api_probe`
  accidentally starts echoing full response bodies.
- There is no documented no-secret smoke recipe that lets an operator confirm
  savings against the collaboration API with `ctx_stats` before and after.

Current live-session evidence also supports the broader token-save claim:

- `ctx_stats` for the collaboration review session reported:
  - Without context-mode: 914 KB, approximately 233.9K tokens.
  - With context-mode: 142 KB, approximately 36.4K tokens.
  - 84% kept out of context.
- This confirms the context boundary is saving tokens at session level.
- It does not, by itself, prove every individual improvement item is still
  working; per-tool and fixture-level regression checks remain necessary.

## Third-Pass Review Items

### 1. Add an end-to-end savings smoke script

**Status: implemented**

**Goal**

Make the token-save check repeatable without asking an operator to manually
compare `ctx_stats` output.

**Plan**

- Added a no-secret script that:
  - runs a compact API probe against a configurable URL
  - defaults to an in-process fixture server
  - prints only returned bytes, avoided bytes, ratio, and pass/fail status
- Require all secrets to arrive through environment variables.
- Default to a local fixture server so CI and contributors can run it without
  internal network access.
- Allow an optional collaboration API URL for operator smoke testing.

**Touched files**

- `scripts/ctx-api-probe-savings-smoke.mjs`
- `tests/scripts/ctx-api-probe-savings-smoke.test.ts`
- `package.json`
- `docs/improvement-plans/ctx-api-probe-savings-attribution.md`

**Acceptance criteria**

- The script fails if avoided bytes do not increase after a large compact
  probe.
- The script never prints Authorization headers, cookies, or response bodies.
- The script works with a local fixture and does not require the KTL network.

### 2. Add a per-tool savings regression table fixture

**Status: implemented**

**Goal**

Verify that `ctx_stats` reports exact savings for tools that emit
`bytes_avoided`, while preserving fallback estimates for older tools.

**Plan**

- Seeded a session DB with mixed tool events:
  - `ctx_api_probe` with exact `bytes_returned` and `bytes_avoided`
  - `ctx_execute` with returned bytes but no exact avoided bytes
  - an index/cache event with avoided bytes
- Rendered `formatReport()`.
- Assert the per-tool table uses exact values where available and fallback
  values only where exact values are absent.

**Touched files**

- `tests/analytics/metrics.test.ts`

**Acceptance criteria**

- `ctx_api_probe` appears with exact avoided bytes.
- Tools without exact event attribution still render useful estimates.
- Event metadata bytes are not counted as model-context savings.

### 3. Document a decision threshold for "saving enough"

**Status: implemented**

**Goal**

Avoid treating any positive byte reduction as sufficient when a tool is meant
to prevent large output from entering context.

**Plan**

- Defined minimum expected compression thresholds by workflow:
  - compact API probe: raw response at least 5x returned output for large JSON
    endpoints
  - large file/log summarization: at least 10x unless the requested summary is
    intentionally detailed
  - indexed docs search: lower savings are acceptable because exact snippets
    are returned
- Put the thresholds near the smoke recipe so operators can interpret results.

**Touched files**

- `docs/improvement-plans/ctx-api-probe-savings-attribution.md`

**Acceptance criteria**

- The docs say when savings are healthy, suspicious, or expectedly low.
- The thresholds distinguish compact summaries from exact-snippet retrieval.
- The guidance explains that the strict-compression headline remains the source
  of truth for session-level savings.

## Additional Improvement Items

### 1. Use exact per-tool avoided bytes in `ctx_stats`

**Status: implemented**

**Goal**

Make `ctx_stats` answer, "Did this specific tool save tokens?" without relying
on a global savings-ratio estimate.

**Problem**

The current active-session per-tool table derives `estimatedSaved` by applying
the conversation-wide savings percentage to each tool's returned bytes. That is
acceptable for rough display, but it hides exact attribution that now exists in
`session_events.bytes_avoided`.

**Plan**

- Added a per-tool real-byte aggregation for the current session:
  - tool name
  - calls
  - bytes returned
  - bytes avoided
- Fed that aggregation into `formatReport()`.
- Prefer exact `bytes_avoided` when available.
- Fall back to the existing ratio estimate only for tools without exact
  avoided-byte events.
- Kept the headline strict-compression formula unchanged:
  `1 - bytesReturned / (bytesReturned + bytesAvoided)`.

**Touched files**

- `src/session/analytics.ts`
- `tests/analytics/format-report.test.ts`
- `tests/analytics/metrics.test.ts`

**Acceptance criteria**

- A session containing `ctx_api_probe` events shows `ctx_api_probe` with exact
  avoided bytes.
- The per-tool table no longer attributes the same global ratio to every tool
  when exact event data exists.
- Existing tools without exact avoided-byte events keep their current display
  behavior.
- Event metadata bytes are not folded into the Section 1 strict-compression
  ratio.

### 2. Add a raw-vs-compact `ctx_api_probe` fixture test

**Goal**

Protect the token-saving behavior with a deterministic test.

**Plan**

- Add a local fixture HTTP server that returns a large JSON response with a few
  known nested fields.
- Run `ctx_api_probe` with a small `select` list.
- Assert:
  - raw response bytes exceed a meaningful threshold
  - compact output bytes stay below a fixed ceiling
  - selected JSON paths are returned
  - `bytesAvoided` equals raw response bytes minus compact output bytes
  - the full response body is not present in the tool output

**Likely touch points**

- `tests/core/api-probe-savings.test.ts` or a focused section in
  `tests/core/server.test.ts`
- existing test helpers for local HTTP servers, if available

**Acceptance criteria**

- The test fails if the compact probe starts echoing full JSON bodies.
- The test fails if avoided-byte attribution is removed.
- The test requires no external network and no secrets.

### 3. Add a safe collaboration API smoke recipe

**Goal**

Give operators a repeatable manual check for token savings without leaking
auth headers or dumping internal API payloads.

**Plan**

- Document a smoke flow:
  - run `ctx_stats`
  - run `ctx_api_probe` against a known large collaboration API endpoint with a
    placeholder auth header and a small `select` list
  - run `ctx_stats` again
  - confirm returned bytes are compact and avoided bytes increased
- Include an HTTPS variant using `ca_file` for internal CA endpoints.
- Use placeholders for secrets; do not commit real tokens.

**Likely touch points**

- `docs/improvement-plans/ctx-api-probe-savings-attribution.md`
- `README.md`, only if the recipe should become user-facing

**Acceptance criteria**

- The recipe gives a clear yes/no signal for token-save attribution.
- The recipe does not include real tokens, cookies, signed URLs, or private
  host-specific credentials.
- The recipe works for both HTTP internal API probes and HTTPS probes with
  `ca_file`.

### 4. Separate the `ctx_index` regression cleanup from savings work

**Status: resolved during review**

**Goal**

Keep token-savings work reviewable by isolating unrelated failing tests.

**Problem**

The targeted run initially showed `ctx_index` path-resolution and
directory-indexing failures in `tests/core/server.test.ts`. Those failures
were not caused by `ctx_api_probe` savings attribution.

**Resolution**

- The JetBrains simulation test environment now removes `CODEX_THREAD_ID` and
  `CODEX_CI` so Codex platform detection does not override
  `IDEA_INITIAL_DIRECTORY`.
- `tests/core/server.test.ts` was re-run as a full file and passed.

**Acceptance criteria**

- `ctx_api_probe` savings tests can pass independently.
- The former `ctx_index` failures are covered by the full
  `tests/core/server.test.ts` run.
- Final verification distinguishes savings-specific checks from full-suite
  health when new failures appear.

## Recommended Next Work Order

1. Add the raw-vs-compact fixture test.
2. Keep exact per-tool avoided-byte aggregation covered in analytics tests.
3. Promote the smoke threshold guidance to public benchmark docs if this should
   become release-facing documentation.
