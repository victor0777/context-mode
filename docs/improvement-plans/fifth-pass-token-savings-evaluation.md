# Fifth-Pass Token Savings Evaluation and Next Improvements

## Context

Four improvement passes have already targeted the main token-saving risks:

- `ctx_api_probe` savings attribution for large HTTP responses.
- `ctx_stats` scope wording and strict-compression clarity.
- Per-tool avoided/returned byte reconciliation.
- Codex SessionStart routing-block size and duplicate-injection controls.

This fifth pass should answer two practical questions:

1. Are tokens still being saved in normal agent work, not only in unit fixtures?
2. What additional improvements are still worth doing after the first four passes?

## Current Evidence

Live `ctx_stats` from a Codex session on 2026-06-02 reported:

- Without context-mode: `1.0 MB`, about `266.8K tokens`.
- With context-mode: `183 KB`, about `46.8K tokens`.
- Reported reduction: `82% kept out of context`.
- Reported runtime extension: about `6x longer before /compact`.

Assessment: token saving is working in the observed session. The reduction is below the marketing-level `98%` figure, but this is expected when the session includes fixed startup guidance, final answers, compact summaries, and short tool outputs that are intentionally model-facing.

Important caveat: the stats report has multiple scopes. Session/current-chat, project, and lifetime figures must not be treated as one arithmetic hierarchy unless the report explicitly says they use the same store and denominator.

## Remaining Improvement Items

### 1. Add a repeatable live savings benchmark

**Status: implemented**

Create a deterministic benchmark script that runs a small matrix of typical context-mode workflows:

- noisy shell output through `ctx_execute`;
- large local file summarization through `ctx_execute_file`;
- multi-command repository lookup through `ctx_batch_execute`;
- large JSON endpoint probe through `ctx_api_probe`;
- indexed-document retrieval through `ctx_search`.

Suggested paths:

- `scripts/token-savings-benchmark.mjs`
- `tests/scripts/token-savings-benchmark.test.ts`

Package script:

- `npm run benchmark:token-savings`

Acceptance criteria:

- The benchmark emits raw bytes, returned bytes, avoided bytes, and ratio per tool.
- The benchmark has no external network dependency by default.
- The test fails if a tool starts returning full raw payloads.
- The output includes a clear pass/fail threshold for each tool class.

Implementation notes:

- The benchmark is local and deterministic; it simulates representative tool
  boundaries instead of requiring a live MCP host.
- It covers `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`,
  `ctx_api_probe`, and `ctx_search`.
- JSON mode (`--json`) is intended for CI or future dashboard ingestion.

### 2. Track fixed routing overhead separately

The SessionStart routing block is useful but still consumes context. It should be reported as fixed overhead, not blended into data-savings ratios.

Suggested paths:

- `src/session/analytics.ts`
- `hooks/routing-block.mjs`
- `tests/analytics/format-report.test.ts`
- `tests/hooks/core-routing.test.ts`

Acceptance criteria:

- `ctx_stats` can show a line such as `Fixed routing/context overhead`.
- Strict compression remains based on raw-data avoided versus returned data bytes.
- Routing-block size remains under the Codex compact budget.
- Tests fail on duplicated routing-block injection.

### 3. Add stats denominator regression tests

The most important user-trust risk is not whether bytes are saved, but whether the percentage is computed from the intended denominator.

Suggested paths:

- `tests/analytics/metrics.test.ts`
- `tests/session/stats-output-format.test.ts`
- `src/session/analytics.ts`

Acceptance criteria:

- For every displayed percentage, tests assert the exact numerator and denominator.
- Mixed-scope values include labels such as current chat, project store, or lifetime store.
- No formatted sentence implies that narrower and wider scopes are directly comparable when they are not.

### 4. Add per-host visibility checks

Some hosts visibly print hook-injected context while others keep it internal. That affects perceived token cost and user trust even when the routing works.

Suggested paths:

- `docs/platform-support.md`
- `docs/adapters/codex.md` if added, or the Codex section in `README.md`
- adapter-specific hook tests under `tests/hooks/`

Acceptance criteria:

- Codex, Claude Code, OpenCode/KiloCode, Cursor, and Pi each document whether routing context is visible to the user/model.
- Each host has a minimal check proving that `ctx stats` is reachable after startup.
- If a host cannot hide hook context, docs explain the fixed-overhead tradeoff.

### 5. Add a "savings suspicious" diagnostic

When savings are unexpectedly low, users need an actionable explanation instead of only a percentage.

Suggested paths:

- `src/session/analytics.ts`
- `src/server.ts`
- `tests/analytics/format-report.test.ts`

Acceptance criteria:

- `ctx_stats` flags suspicious sessions when large raw inputs return low avoided-byte ratios.
- The diagnostic distinguishes expected low savings for tiny payloads from suspicious low savings for large payloads.
- The message suggests concrete next checks: routing hooks, duplicate MCP registration, raw Bash/Read usage, or missing per-tool attribution.

## Evaluation Recipe

Use this recipe after implementing the next pass:

1. Start a fresh session in a repository with context-mode enabled.
2. Run one large local-file summary via `ctx_execute_file`.
3. Run one noisy multi-command lookup via `ctx_batch_execute`.
4. Run one large local JSON/API fixture via `ctx_api_probe`.
5. Run `ctx_stats`.
6. Confirm:
   - avoided bytes are larger than returned bytes for each large-data tool;
   - fixed routing overhead is visible or documented;
   - the headline percentage uses one explicit scope;
   - per-tool totals reconcile with the selected headline scope.

## Recommended Next Work Order

1. Add denominator and overhead reporting tests next; they protect user trust in `ctx_stats`.
2. Add suspicious-savings diagnostics after the metrics are stable.
3. Update host visibility docs last, based on the measured behavior.

## Path

`docs/improvement-plans/fifth-pass-token-savings-evaluation.md`
