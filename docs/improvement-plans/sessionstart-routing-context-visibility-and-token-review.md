# SessionStart Routing Context Visibility and Token Review

## Context

During Codex startup the user observed this block in the conversation surface:

```text
SessionStart hook (completed)
hook context:
  <context_window_protection>
    ...
  </context_window_protection>

UserPromptSubmit hook (completed)
hook context:
```

This review checks whether that is intended, whether token savings still work,
and what further improvements should be considered after the prior
`ctx_api_probe` and `ctx_stats` savings work.

## Current Assessment

The `SessionStart` routing block injection is intentional.

- `hooks/routing-block.mjs` defines the `<context_window_protection>` block.
- `hooks/sessionstart.mjs` and `hooks/codex/sessionstart.mjs` return it through
  `hookSpecificOutput.additionalContext`.
- `tests/session/continuity.test.ts` explicitly asserts that SessionStart emits
  `<context_window_protection>`, `<tool_selection_hierarchy>`,
  `<when_not_to_use>`, and `<output_constraints>`.
- `src/adapters/codex/index.ts` formats SessionStart responses as
  `hookSpecificOutput: { hookEventName: "SessionStart", additionalContext }`.
- `docs/platform-support.md` documents that Codex context injection works via
  `PostToolUse` and `SessionStart`.

So the answer to "is this intended?" is:

- Intended: yes, the block is intentionally injected as model-facing routing
  guidance.
- UX concern: also yes, if the host visibly prints the whole hook context at
  the start of every session, that is noisy and looks like internal machinery.
- Token concern: bounded but real. The Codex routing block is currently about
  3.9 KB, roughly 1K tokens, before any resume snapshot or session directive is
  appended.

## Token-Savings Evaluation

The current token-saving direction still looks correct.

- The routing block costs a fixed startup budget, but it is meant to prevent
  much larger raw tool outputs from entering the conversation later.
- The user's observed `ctx_stats` result for the review session was:
  - Without context-mode: 914 KB
  - With context-mode: 142 KB
  - 84% kept out of context
- That session-level result is strong evidence that the overall behavior is
  saving tokens as intended.
- The new `ctx_api_probe` path also keeps raw HTTP bodies inside the sandbox and
  returns compact evidence only.
- `ctx_stats` per-tool reporting now prefers exact `bytes_avoided` events where
  available, so `ctx_api_probe` savings are no longer hidden behind a global
  ratio estimate.

The remaining question is not "does token saving work at all?" It is:

1. Can startup guidance be smaller without reducing correct tool selection?
2. Can host-visible hook context be suppressed or summarized?
3. Can tests detect accidental growth or duplicated injection?

## Improvement Items

### 1. Add a routing-block size budget test

**Status: implemented**

**Goal**

Prevent the SessionStart guidance from growing silently.

**Plan**

- Added a unit test that measures compact routing output.
- Set a documented byte ceiling of 2.0 KB for the compact Codex startup block.
- Fail the test if the block exceeds the ceiling.
- Keep separate assertions for required semantic markers:
  - `<context_window_protection>`
  - `ctx_batch_execute`
  - `ctx_execute_file`
  - `ctx_fetch_and_index`
  - `ctx_stats`

**Likely touch points**

- `tests/hooks/core-routing.test.ts`
- `hooks/routing-block.mjs`

**Acceptance criteria**

- The block cannot grow past the budget without an explicit test update.
- Required guidance still exists.
- The test reports the measured byte count when it fails.

### 2. Add a compact Codex SessionStart variant

**Status: implemented**

**Goal**

Reduce the fixed startup token cost for Codex while keeping the routing
behavior that drives savings.

**Plan**

- Added an option to `createRoutingBlock()`:
  `{ verbosity: "full" | "compact" }`.
- Use the compact variant in `hooks/codex/sessionstart.mjs`.
- Keep the full variant for platforms where the longer guidance is still useful
  or already expected by tests.
- Preserve the high-value rules:
  - use `ctx_search(sort: "timeline")` on resume/compaction
  - use `ctx_batch_execute` / `ctx_execute` for processing output
  - use `ctx_execute_file` for file analysis
  - use `ctx_fetch_and_index` for web content
  - use native Write/Edit for persistent file writes

**Likely touch points**

- `hooks/routing-block.mjs`
- `hooks/codex/sessionstart.mjs`
- `tests/session/continuity.test.ts`
- `tests/hooks/core-routing.test.ts`
- Codex-specific adapter tests if they assert exact routing content

**Acceptance criteria**

- Codex SessionStart routing guidance is materially smaller, now about 1.36 KB
  instead of about 3.9 KB.
- The compact block still contains the required tool-selection rules.
- Existing non-Codex SessionStart behavior is unchanged unless explicitly
  migrated.
- `ctx_stats` for normal work still shows savings; the compact guidance must
  not cause agents to fall back to raw Bash/Read/WebFetch habits.

### 3. Investigate host-visible hook-context suppression

**Goal**

Keep model-facing guidance available while avoiding noisy user-visible startup
transcripts when the host displays hook context.

**Plan**

- Verify whether Codex currently exposes `additionalContext` visibly by design
  or because a debug/logging mode is enabled.
- Check whether Codex has a hook output mode that injects context without
  printing full hook context to the transcript.
- If no host-side suppression exists, document this as a Codex caveat and prefer
  the compact SessionStart variant.

**Likely touch points**

- `src/adapters/codex/index.ts`
- `hooks/codex/sessionstart.mjs`
- `docs/platform-support.md`
- `docs/adapters/codex*.md` if present

**Acceptance criteria**

- Users know whether the visible startup block is expected.
- If suppression is possible, context-mode uses it.
- If suppression is not possible, the docs explain the tradeoff and the block
  is kept compact.

### 4. Avoid empty `UserPromptSubmit` additionalContext noise

**Status: implemented**

**Goal**

Stop returning an empty context payload that may produce visible "hook context:"
noise.

**Current observation**

`hooks/codex/userpromptsubmit.mjs` always writes:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": ""
  }
}
```

If Codex displays this as an empty hook context, it adds visible noise without
adding guidance or savings.

**Plan**

- Omit `additionalContext` when empty.
- Keep `hookSpecificOutput.hookEventName = "UserPromptSubmit"`.
- Add a regression assertion that the Codex hook output no longer has an empty
  `additionalContext` field.

**Likely touch points**

- `hooks/codex/userpromptsubmit.mjs`
- `src/adapters/codex/index.ts`
- `tests/hooks/*codex*` or add a focused Codex hook output test

**Acceptance criteria**

- UserPromptSubmit still captures prompts for continuity.
- Empty additional context no longer appears in the user-visible transcript when
  the host permits omission.
- Tests cover the chosen output shape.

### 5. Add duplicate-injection regression coverage

**Status: partially implemented**

**Goal**

Ensure the routing block appears once per intended SessionStart boundary, not
multiple times due to resume/compact/startup interactions.

**Plan**

- Added a startup test that runs the Codex SessionStart hook.
- Count occurrences of `<context_window_protection>`.
- Assert exactly one routing block per hook output for startup.
- Include resume snapshot/session directive cases to catch accidental duplicate
  concatenation as a remaining follow-up.

**Likely touch points**

- `tests/hooks/codex-*` or a new focused `tests/hooks/codex-sessionstart.test.ts`
- `hooks/codex/sessionstart.mjs`

**Acceptance criteria**

- Startup emits exactly one routing block.
- Resume emits exactly one routing block plus any intended resume/session
  directive.
- Compact emits exactly one routing block plus intended compact directive.

## Recommended Next Work Order

1. Extend duplicate-injection regression coverage to resume and compact.
2. Update Codex platform docs based on whether host-visible hook context can be
   suppressed.
3. Monitor `ctx_stats` after the compact block ships to ensure agents still
   choose context-mode tools for large-output work.

## Path

This plan lives at:

`docs/improvement-plans/sessionstart-routing-context-visibility-and-token-review.md`
