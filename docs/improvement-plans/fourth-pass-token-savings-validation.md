# Fourth-Pass Token Savings Validation Plan

## Context

This is a follow-up after the `ctx_api_probe`, per-tool savings attribution,
smoke-script, and SessionStart routing-context improvements.

The current goal is no longer just "add another savings feature." The next
useful pass should prove that context-mode is saving tokens as intended and
that the user-facing `ctx_stats` report explains the savings with internally
consistent scopes.

## Current Evidence

Observed from a live `ctx_stats` run on 2026-06-02:

- Current chat:
  - Without context-mode: `936 KB`, approximately `239.7K tokens`.
  - With context-mode: `159 KB`, approximately `40.7K tokens`.
  - Reported reduction: `83% kept out of context`, approximately `6x` longer
    before compact.
- Project/lifetime section:
  - The report says `This chat: 1.1 MB kept out`.
  - The report also says `All your work: 392 KB kept out`.

The first set of numbers supports the intended savings behavior: large raw
outputs are staying out of the model context while compact summaries are
returned.

The second set exposes the next quality problem: the narrative mixes scopes or
labels in a way that can make "this chat" appear larger than "all your work."
That may be mathematically explainable if the two values use different
formulas, projects, or stores, but the report does not make that distinction
clear enough for a user to trust the savings claim.

## Assessment

Token saving appears to work at the tool boundary.

Known protected boundaries:

- `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute` process raw bytes in
  the sandbox and return compact derived output.
- `ctx_api_probe` records the HTTP response byte count while returning compact
  status, metadata, selected JSON paths, or a short excerpt.
- `ctx_stats` can aggregate `bytes_avoided` and `bytes_returned` by tool.

The remaining improvement area is validation and reporting fidelity:

1. The stats report should use one explicit scope per headline value.
2. Session, project, and lifetime totals should not be visually compared unless
   they are computed from the same metric family.
3. The per-tool savings table should be easy to reconcile with the headline
   savings values.
4. The smoke script should be part of normal verification, not a separate
   optional check that can be forgotten.

## Improvement Items

### 1. Add a stats-scope consistency regression

**Status: implemented**

Target files:

- `src/session/analytics.ts`
- `tests/analytics/format-report.test.ts`
- `tests/analytics/metrics.test.ts`
- `tests/session/stats-output-format.test.ts`

Add a fixture where:

- conversation avoided bytes are larger than project or lifetime avoided bytes
  only if the scopes are intentionally different;
- the formatted output labels each number with the exact scope and metric;
- no line implies that a narrower scope is larger than a wider scope when both
  are drawn from the same store.

Expected result:

- `ctx_stats` output can still show session/project/lifetime numbers, but each
  line names the scope precisely enough that the values are auditable.
- The narrative receipt now labels rows as:
  - `Current chat (conversation DB)`
  - `All your work (available lifetime stores)`
- If the current-chat row is larger than the lifetime row, the report explains
  that the rows use different scopes/stores and should not be read as a strict
  hierarchy.

### 2. Add a per-tool reconciliation test

**Status: implemented**

Target files:

- `src/session/analytics.ts`
- `tests/analytics/metrics.test.ts`
- `tests/analytics/format-report.test.ts`

Create a deterministic fixture with at least these tools:

- `ctx_execute_file`
- `ctx_batch_execute`
- `ctx_api_probe`
- `ctx_search`

The test should assert:

- total avoided bytes equals the sum of per-tool avoided bytes for the selected
  scope;
- total returned bytes equals the sum of per-tool returned bytes for the
  selected scope;
- the displayed headline percentage uses the same numerator and denominator as
  the fixture.

Expected result:

- A future stats wording or aggregation change cannot silently inflate or
  deflate the reported savings.
- The added fixture reconciles exact per-tool `bytes_avoided` and
  `bytes_returned` with the active-session headline scope.

### 3. Promote the API-probe smoke into routine verification

**Status: implemented**

Target files:

- `package.json`
- `.github/workflows/ci.yml`
- `scripts/ctx-api-probe-savings-smoke.mjs`
- `tests/scripts/ctx-api-probe-savings-smoke.test.ts`

The smoke script already checks the key savings boundary: a large raw API body
is consumed while only compact probe output reaches context.

Add it to the normal verification path as either:

- a dedicated CI step; or
- part of an existing test group if runtime cost is low and deterministic.

Expected result:

- `npm run smoke:api-probe-savings` is not just documented; it is enforced.
- CI now runs `npm run smoke:api-probe-savings`.

### 4. Add a compact live-evaluation recipe

**Status: implemented**

Target file:

- `docs/improvement-plans/ctx-api-probe-savings-attribution.md`

Add a short "How to evaluate live savings" section that instructs maintainers
to run:

- one noisy command through `ctx_execute` or `ctx_batch_execute`;
- one large local file through `ctx_execute_file`;
- one large JSON endpoint through `ctx_api_probe`;
- `ctx_stats` afterward.

The recipe should record only:

- command/tool used;
- raw bytes avoided;
- bytes returned;
- displayed stats line;
- pass/fail against a minimum savings threshold.

Expected result:

- A reviewer can answer "is token save working as intended?" without reading
  raw logs or trusting a single marketing-style percentage.
- `ctx-api-probe-savings-attribution.md` now contains a live evaluation recipe
  covering command output, local files, large JSON APIs, and final `ctx_stats`.

## Suggested Acceptance Criteria

The next improvement pass is complete when:

- `npm run typecheck` passes.
- `npm test` passes, or the changed tests pass with a documented reason for not
  running the full suite.
- `npm run smoke:api-probe-savings` passes.
- `ctx_stats` no longer shows ambiguous scope wording such as a narrower
  "This chat" savings total appearing larger than "All your work" without a
  clear explanation.
- Per-tool avoided/returned byte totals reconcile with the selected headline
  stats scope.

## Recommended Next Work Order

1. Fix and test `ctx_stats` scope wording and aggregation first.
2. Add the per-tool reconciliation fixture.
3. Wire the API-probe smoke into routine verification.
4. Add the compact live-evaluation recipe.

## Implementation Notes

Implemented in this pass:

- `src/session/analytics.ts`: Section 3 wording changed from a widening
  hierarchy to explicit scope/source rows.
- `tests/session/stats-output-format.test.ts`: regression for mixed-store scope
  wording when current-chat bytes exceed available lifetime-store bytes.
- `tests/analytics/metrics.test.ts`: deterministic per-tool
  avoided/returned-byte reconciliation fixture.
- `.github/workflows/ci.yml`: API probe savings smoke added to CI.
- `docs/improvement-plans/ctx-api-probe-savings-attribution.md`: live savings
  evaluation recipe added.

This order keeps the work reviewable: reporting correctness first, then
regression coverage, then CI enforcement, then documentation.

## Path

`docs/improvement-plans/fourth-pass-token-savings-validation.md`
