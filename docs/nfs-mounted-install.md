# NFS-Mounted Development Install

This guide covers installing context-mode on multiple servers when the
repository directory is shared through NFS.

The source tree can be shared. Runtime setup is still per-server.

## What Is Shared

The NFS-mounted repository can provide:

- source files
- bundled files such as `cli.bundle.mjs` and `server.bundle.mjs`
- hook scripts under `hooks/`
- config templates under `configs/`

Do not assume these are shared safely:

- shell `PATH`
- `nvm` Node versions
- globally installed npm binaries
- `~/.codex/config.toml`
- `~/.codex/hooks.json`
- context-mode session and content databases
- native module ABI state under `node_modules/better-sqlite3`

Each server must be configured independently.

## Recommended Layout

Use one shared source directory and per-server user config:

```text
/mnt/nfs/context-mode          # shared repository
~/.nvm                         # local to each server
~/.codex                       # local to each server
~/.codex/context-mode          # local session/content storage
```

Avoid putting `~/.codex` on NFS unless you deliberately want shared session
history. SQLite WAL files are safer and simpler when each server writes to its
own local storage directory.

## Prerequisites On Each Server

Install or load `nvm`, then install Node.js 22.5 or newer:

```bash
source ~/.nvm/nvm.sh
nvm install 22.5.0
nvm use 22.5.0
nvm alias default 22.5.0
```

Install Codex CLI on that Node prefix:

```bash
npm install -g @openai/codex
codex --version
```

Node.js below 22.5 is unsupported on Linux for context-mode because of the
`better-sqlite3` native-addon crash risk. If the server already has `codex`
installed under an older Node prefix, install it again after `nvm use 22.5.0`
so `codex` is available in the same environment as `context-mode`.

## First Server Setup

On one server, prepare the shared repository:

```bash
cd /mnt/nfs/context-mode
source ~/.nvm/nvm.sh
nvm use 22.5.0
npm install
npm run build
npm link
context-mode upgrade
context-mode doctor
```

`npm link` creates the `context-mode` command in that server's active npm
prefix. It does not make the command available on other servers.

## Additional Server Setup

On every other server that mounts the same directory:

```bash
cd /mnt/nfs/context-mode
source ~/.nvm/nvm.sh
nvm install 22.5.0
nvm use 22.5.0
nvm alias default 22.5.0
npm install -g @openai/codex
npm link
npm rebuild better-sqlite3
context-mode upgrade
context-mode doctor
```

Run `npm rebuild better-sqlite3` whenever the shared `node_modules` directory
was installed or rebuilt by a different Node ABI, different architecture, or
different operating system. If all servers are the same Linux architecture and
use the same Node version, this should be stable after the first rebuild.

For mixed OS or mixed CPU architecture fleets, do not share one `node_modules`
directory. Use a separate checkout per platform or install context-mode from
npm on each server:

```bash
npm install -g context-mode
context-mode upgrade
context-mode doctor
```

## Codex Hook Verification

After `context-mode upgrade`, each server should have:

```text
~/.codex/config.toml   # contains [features] hooks = true
~/.codex/hooks.json    # contains context-mode hook commands
```

Verify the hook commands directly:

```bash
printf '{"tool_name":"Bash","tool_input":{"command":"true"},"cwd":"'"$PWD"'","session_id":"nfs-test"}' \
  | context-mode hook codex pretooluse

printf '{"tool_name":"Bash","tool_input":{"command":"true"},"tool_response":{"stdout":"","stderr":"","exit_code":0},"cwd":"'"$PWD"'","session_id":"nfs-test"}' \
  | context-mode hook codex posttooluse
```

Both commands should print JSON and exit with code `0`.

## Optional Shared Data Directory

By default, Codex context-mode data lives under:

```text
~/.codex/context-mode
```

If you want a specific per-server local directory, launch Codex with:

```bash
CONTEXT_MODE_DIR="$HOME/.codex-context-mode" codex
```

Use an absolute path. Do not use `~` inside `CONTEXT_MODE_DIR`; it is not
expanded by context-mode.

Only point multiple servers at the same `CONTEXT_MODE_DIR` if you accept shared
session history and possible SQLite lock contention under concurrent use.

## Troubleshooting

If Codex reports:

```text
PreToolUse hook failed: hook exited with code 127
PostToolUse hook failed: hook exited with code 127
```

then the hook command could not be found. Check:

```bash
command -v context-mode
context-mode --help
cat ~/.codex/hooks.json
```

If `context-mode` is missing, rerun:

```bash
cd /mnt/nfs/context-mode
source ~/.nvm/nvm.sh
nvm use 22.5.0
npm link
```

If `context-mode doctor` reports a `better-sqlite3` ABI mismatch, rerun:

```bash
cd /mnt/nfs/context-mode
source ~/.nvm/nvm.sh
nvm use 22.5.0
npm rebuild better-sqlite3
context-mode doctor
```

Restart Codex after changing Node versions, npm global links, or hook config.
