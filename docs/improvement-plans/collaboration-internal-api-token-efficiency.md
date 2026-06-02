# Collaboration Internal API Token-Efficiency Improvements

## Context

While using context-mode from `/home/ktl/projects/collaboration` against
`collaboration.ktl.com` and the canonical internal API, several concrete
improvement opportunities appeared.

The collaboration runtime currently uses:

- Dashboard: `https://collaboration.ktl.com`
- Canonical API: `http://192.168.0.193:7851`
- Auth header for API probes: `Authorization: Bearer sk-collab-dashboard`

The workflow goal is to keep dashboard HTML, API responses, logs, and generated
reports out of the model context by using context-mode tools as the default
retrieval and summarization layer.

## Observed Results

- `ctx_execute` worked well for compact API probing and returned only the
  selected evidence.
- `ctx_index` and `ctx_search` worked well once absolute file paths and clear
  source labels were used.
- `ctx_stats` showed meaningful savings for the investigation:
  approximately 68.9% reduction and 11.9K tokens saved.

## Improvement Items

### 1. Trusted internal HTTPS support for `ctx_fetch_and_index`

**Status: implemented**

**Problem**

`ctx_fetch_and_index` failed against `https://collaboration.ktl.com` because the
Node fetch runtime did not trust the KTL internal CA:

```text
TypeError: fetch failed
cause: Error: unable to verify the first certificate
code: UNABLE_TO_VERIFY_LEAF_SIGNATURE
```

`curl` on the same host could fetch the dashboard, so this is specifically a
Node trust-store/configuration gap rather than a service outage.

**Plan**

- Add an explicit trusted-CA option to `ctx_fetch_and_index`: `ca_file`.
- Keep TLS verification enabled by default.
- Do not add an insecure skip-verification mode as the primary solution.
- Support both single `url` and batch `requests` fetch paths.
- Include the CA option in cache-key inputs only if it affects response
  identity or trust context.

**Implementation notes**

- `ca_file` is accepted on both the legacy single URL shape and each batch
  request object.
- Relative `ca_file` paths resolve against the caller project directory.
- The CA file path is checked against the Read deny policy and must exist.
- The trusted CA is passed to the child Node fetch process via
  `NODE_EXTRA_CA_CERTS`; `NODE_TLS_REJECT_UNAUTHORIZED=0` and
  `rejectUnauthorized: false` are intentionally not used.

**Likely touch points**

- `src/server.ts`
- `src/fetch-cache.ts`
- tests around `ctx_fetch_and_index`

**Verification**

- Unit coverage verifies `nodeExtraCaCerts` reaches only the spawned Node
  process.
- Static handler coverage verifies `ca_file` schema and TLS-safe pass-through.
- Manual smoke for a real KTL internal CA endpoint is still recommended.

### 2. Workspace-anchored path handling for `ctx_index`

**Status: already covered in current codebase**

**Problem**

Calling `ctx_index(path: "CLAUDE.md")` from the collaboration session resolved
against the context-mode server working directory, not the caller workspace.
This can silently index the wrong file when multiple projects have a
`CLAUDE.md`, `AGENTS.md`, or `README.md`.

**Plan**

- Resolve relative paths against the detected caller project/workspace when
  available.
- If caller workspace cannot be determined, reject relative paths with a clear
  error that asks for an absolute path.
- Include the resolved absolute path in the success response.
- Keep absolute paths working exactly as they do now.

**Likely touch points**

- `src/server.ts`
- project detection / adapter context utilities
- tests for `ctx_index`

**Verification**

- Existing regression coverage in `tests/core/server.test.ts` verifies:
  - absolute path indexing
  - relative path with known project root
  - fallback behavior when project-root envs are unavailable
  - source-label canonicalization to the resolved absolute path

### 3. Shell keyword handling in `ctx_batch_execute`

**Status: implemented**

**Problem**

A command beginning with a shell `for` loop failed after environment injection:

```text
syntax error near unexpected token `do'
NODE_OPTIONS='...' for url in ...; do ...
```

Wrapping the command in `bash -lc '...'` worked, but the tool should not require
callers to know this edge case.

**Plan**

- Ensure the POSIX `NODE_OPTIONS` injection is a complete shell statement,
  not an inline assignment before user shell syntax.
- Add coverage for commands starting with shell reserved words.

**Likely touch points**

- command execution path used by `ctx_batch_execute`
- shared executor utilities if `ctx_execute` uses the same injection path
- tests around batch shell commands

**Verification**

- Regression tests cover commands beginning with:
  - `for`
  - `while`
  - `if`
  - function definitions
- Confirm `NODE_OPTIONS` preload behavior still applies.

### 4. Compact authenticated API fetch mode

**Status: implemented as `ctx_api_probe`**

**Problem**

For internal APIs, agents often need only selected JSON paths, status codes, and
byte counts. Today this is possible with `ctx_execute`, but every agent must
write custom shell or JavaScript.

**Plan**

- Add a small structured API probe mode as a new `ctx_api_probe` tool.
- Inputs should include URL, method, headers, optional selected JSON paths, and
  redaction behavior.
- Output should default to compact evidence:
  request URL, HTTP status, content type, response size, selected values, and
  short error excerpt.

**Implementation notes**

- `ctx_api_probe` accepts `url`, `method`, `headers`, `body`, `select`, and
  `ca_file`.
- It runs the same SSRF preflight guard as `ctx_fetch_and_index`.
- It does not write to the persistent content index.
- Response text is passed through `redactSensitiveText()` before entering the
  model context.

**Likely touch points**

- `src/server.ts`
- tool schemas and descriptions
- redaction utilities
- tests for header redaction and selected JSON paths

**Verification**

- Unit/static coverage verifies selected JSON-path extraction, compact output
  fields, auth-header input support, CA pass-through, SSRF guard use, redacted
  output, and no persistent indexing.

### 5. Secret redaction before indexing command output

**Status: implemented for persistent indexing paths**

**Problem**

Collaboration API probes include Authorization headers and may include artifact
URLs or operational identifiers. context-mode already has session extraction
redaction logic, but command outputs that are auto-indexed by batch workflows
should have an explicit redaction profile before persistent indexing.

**Plan**

- Audit whether `ctx_batch_execute`, `ctx_execute` with intent, and
  `ctx_fetch_and_index` apply the same redaction boundary before writing to
  persistent storage.
- Add and expose a named redaction profile for:
  - `Authorization: Bearer ...`
  - `api_key`, `token`, `secret`, `password`
  - cookies
  - signed URLs
  - known internal API keys
- Include a response note when redaction changed indexed content.

**Implementation notes**

- `redactSensitiveText()` is applied before persistent indexing for:
  - `ctx_batch_execute` output
  - `ctx_execute` / `ctx_execute_file` large-output indexing
  - `ctx_execute` / `ctx_execute_file` intent-search indexing
  - `ctx_fetch_and_index` fetched content
- Byte accounting still uses the original output size, because those are the
  bytes kept out of the model context.

**Likely touch points**

- `src/session/extract.ts`
- indexing path used by `ctx_batch_execute`
- indexing path used by `ctx_fetch_and_index`
- tests for command-output indexing

**Verification**

- Unit coverage verifies masking for auth headers, cookies, JSON-like secret
  keys, signed URL parameters, and `sk-...` style keys.
- Static coverage verifies persistent indexing paths use redacted text before
  writing to the store.

### 6. Authenticated cached fetch for internal docs and dashboards

**Status: implemented**

**Problem**

Internal dashboard or API documentation pages may require headers and should be
cached/indexed with clear source labels and TTL controls.

**Plan**

- Extend fetch/index request shapes with safe authenticated fetch support.
- Ensure auth headers are never displayed or indexed.
- Include source labels, TTL, and cache hit/miss in output.
- Support batch requests with per-request headers if needed.

**Implementation notes**

- `ctx_fetch_and_index` accepts `headers` on both the single URL shape and each
  batch request.
- Authenticated fetch headers are passed only to same-origin redirects; sensitive
  headers are stripped for cross-origin redirects.
- Header values are not displayed or indexed.
- Cache/source labels include a short SHA-256 fingerprint of normalized headers
  when headers are present, so two auth contexts for the same URL do not share a
  cache row.
- Existing `ttl`, `force`, `source`, and batch `concurrency` behavior is
  preserved.

**Likely touch points**

- `src/server.ts`
- `src/fetch-cache.ts`
- fetch/index tool schema
- tests for cache key behavior and redaction

**Verification**

- Unit/static coverage verifies authenticated header schema support, subprocess
  header pass-through, cross-origin redirect stripping, non-secret cache
  fingerprints, and distinct cache keys for different header values.

## Priority

1. `ctx_batch_execute` shell keyword fix: small, high-friction bug.
2. `ctx_index` workspace-relative path safety: prevents silent wrong-file
   indexing.
3. `ctx_fetch_and_index` internal CA support: required for secure internal
   HTTPS.
4. Redaction before indexing: security hardening.
5. Compact authenticated API fetch mode: usability and token-efficiency feature.
6. Authenticated cached fetch: broader internal-doc workflow support.

## Related Collaboration-Side Rule Document

The originating collaboration-side runbook is:

```text
/home/ktl/projects/collaboration/docs/runbooks/context-mode-collaboration-token-rules.md
```

Use it as the scenario document when validating these improvements end to end.
