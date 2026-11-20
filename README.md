# codex-bridge-antigravity

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A lightweight local OpenAI Responses API bridge that seamlessly integrates the official Google Antigravity CLI (`agy`) into OpenAI Codex (Desktop & CLI), while preserving native GPT model routing and authentication.

![Codex model picker showing native GPT and Antigravity models](assets/model-selector.png)

---

## Overview

OpenAI Codex configures WebSocket and HTTP endpoints at the provider level rather than per model. `codex-bridge-antigravity` installs a smart local reverse proxy/router on your machine:

- **Native GPT/Codex Models**: Forwarded untouched to the official OpenAI/ChatGPT backend, preserving your existing Codex Bearer login and session.
- **Antigravity Models (`antigravity/*`)**: Intercepted locally, transformed into official `agy` CLI executions using `stream-json` event streaming, and returned as standard OpenAI Responses SSE/WebSocket streams.

This allows you to seamlessly switch between GPT and Gemini models directly from the Codex model picker dropdown within the exact same workspace.

```
┌─────────────────────────────────────────────────────────────┐
│                        Codex Client                         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ (Provider Route: 127.0.0.1:17842)
┌─────────────────────────────────────────────────────────────┐
│                  codex-bridge-antigravity                   │
│                                                             │
│   ┌───────────────────────────┐   ┌─────────────────────┐   │
│   │   Native GPT / Codex      │   │   antigravity/*     │   │
│   └─────────────┬─────────────┘   └──────────┬──────────┘   │
└─────────────────┼────────────────────────────┼──────────────┘
                  │                            │
                  ▼                            ▼
┌──────────────────────────────────┐   ┌──────────────────────┐
│  Official OpenAI/ChatGPT Backend │   │ Google Antigravity   │
│  (Bearer Token Passthrough)      │   │ CLI (`agy`)          │
└──────────────────────────────────┘   └──────────────────────┘
```

---

## Key Features

- **Zero-Disruption Coexistence**: GPT models continue working via official OpenAI endpoints without going through Antigravity.
- **Dynamic Model Catalog** lists account-advertised Gemini 3.8+ Flash, Gemini 4 and newer families, and Gemini Pro Orchestrators. Model IDs with an effort suffix take precedence over Codex's global effort. AGY manages orchestrator effort.
- **Codex Switcher Compatibility**: Configured with `use_responses_lite = false` to eliminate upstream account validation failures when switching models in Codex.
- **Compaction & History Support**: Full `/v1/responses/compact` handler adhering to OpenAI Compact specifications, enabling seamless automatic conversation compaction.
- **Single-Command Setup & Rollback**: Safely patches `~/.codex/config.toml` with backup, and provides one-command rollback via `disconnect`.

### Image Input

Antigravity model routes advertise `input_modalities: ["text", "image"]`. Local images are stored as private copies under `~/.codex-bridge-antigravity/cache/images`, made readable by `agy`, and inspected in a required image preflight before the main turn. The bridge recognizes `data:image/...;base64,...`, `file://...`, local file paths, and HTTPS image URLs; native GPT routes remain unchanged.

---

## Prerequisites

- **Node.js**: `>= 22.0.0`
- **Google Antigravity CLI (`agy`)**: Installed and authenticated (`agy models` must list available models).
- **OpenAI Codex**: Desktop app or CLI installed.

---

## Quick Start

### 1. Verification & Diagnostics

Clone this repository and verify your local environment:

```bash
git clone https://github.com/Jakevin/codex-bridge-antigravity.git
cd codex-bridge-antigravity

# Run automated test suite
npm test

# Run diagnostic check for agy and Codex paths
node src/cli.mjs doctor
```

### 2. Start Local Daemon

Start the local bridge server (defaults to port `17842`):

```bash
node src/cli.mjs serve --cwd "$PWD"
```

In another terminal, test the endpoints directly:

```bash
# Health check
curl http://127.0.0.1:17842/healthz

# List catalog models
curl http://127.0.0.1:17842/v1/models

# Direct response test
curl http://127.0.0.1:17842/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"antigravity/gemini-4-argon-low","input":"Reply with exactly AGY_OK"}'
```

### 3. Integrate with Codex

Install the bridge into your local Codex configuration:

```bash
node src/cli.mjs setup --cwd "$PWD" --replace-codex-route
```

Restart Codex Desktop or the Codex CLI to see the supported Antigravity models alongside native GPT models in the picker.

On the verified Google AI Pro account (2026-11-13), Hydrogen shares the regular
Gemini weekly/five-hour quota with Flash/Pro. `Orchestrator (Argon)` shares
Argon's dedicated weekly quota, so it cannot bypass an exhausted Argon limit.
Adding it to the picker does not automatically delegate work or change the
default model. Use `antigravity/gemini-pro-orchestrator-g1-pro` explicitly when
that quota is available. Hydrogen XHigh uses `antigravity/gemini-4-hydrogen-xhigh`.

### Model catalog refresh

The running bridge checks both providers at startup and every 15 minutes.
It gets native entries from the signed-in ChatGPT Codex catalog, preserving
the upstream model metadata. It gets Antigravity entries from `agy models`
and publishes the exact IDs for account-advertised Gemini 4 and newer models,
Gemini Pro Orchestrators, and Gemini 3.8+ Flash. Future Gemini families matching
these ID conventions appear automatically. Claude and GPT-OSS remain outside
this policy.

Each successful AGY listing replaces the previous Antigravity entries. If the
account advertises only excluded models, the picker drops all Antigravity
entries. If the command fails or its output contains no recognizable model rows,
the bridge retains the last published entries. Supported older models stay
visible for as long as the account advertises them.

Codex reads `model_catalog_json` on startup. With the bridge's custom provider,
removing that setting falls back to Codex's bundled model list. The bridge
therefore keeps the combined file, replaces it atomically when its contents
change, and updates the running router from the published file. Restart Codex
Desktop or the CLI to see a changed picker. A bridge restart is unnecessary
for model-list changes.

Native discovery uses the installed desktop Codex binary's version where
detected, with `codex` on PATH as a fallback. An older binary may receive an
older catalog. Pass `--codex-binary /path/to/codex` to `setup` to save an explicit
choice, or to `serve` or `refresh-catalog` for that invocation. The request
uses the current file-backed ChatGPT sign-in in `$CODEX_HOME/auth.json`
(default `~/.codex/auth.json`) with the standard ChatGPT Codex endpoint.
The successful response replaces the prior native entries, including removals
and visibility changes. The list reflects the account and client version in
the request. Codex continues to manage credential renewal. For a custom native
backend or credential store, set `CODEX_MODEL_CATALOG` in the bridge environment
to point to a complete Codex catalog file. The bridge re-reads that file during
refresh.

If either source is unavailable or returns an unusable list, the bridge keeps
that provider's last usable entries and applies updates from the other. On the
first run it can seed native entries from `$CODEX_HOME/models_cache.json`.
Without a usable native source or cache, `setup` exits before changing Codex
configuration.
Run `node src/cli.mjs refresh-catalog` for an immediate refresh. An existing
bridge service runs the background refresh after restarting onto this version.
Use `--catalog-refresh-sec` with `setup` or `serve` to choose a different interval.
On macOS, `setup` configures a launch agent. On Linux, start `serve` in the
foreground or configure a user service to keep it running.
See the [Codex configuration reference](https://developers.openai.com/codex/config-reference/).

### 4. Disconnect & Restore

To restore your pre-setup Codex configuration at any time:

```bash
node src/cli.mjs disconnect
```

---

## Execution Modes

When running `serve`, you can specify the tool execution mode:

- **`accept-edits` (Default)**: AGY executes coding tools directly inside your specified working directory.
- **`plan`**: Read-only planning mode for inspection and analysis without writing file changes:
  ```bash
  node src/cli.mjs serve --cwd "$PWD" --mode plan
  ```

---

## Configuration & Environment Variables

The default configuration file is saved in `~/.codex-bridge-antigravity/`.

You can override paths and ports using environment variables:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Bridge HTTP/WebSocket listening port | `17842` |
| `AGY_PATH` | Path to the official `agy` executable | Discovered from `$PATH` |
| `CODEX_HOME` | Codex configuration directory | `~/.codex` |
| `CODEX_ANTIGRAVITY_HOME` | Bridge runtime state directory | `~/.codex-bridge-antigravity` |

---

## Troubleshooting

- **Model Switcher Error (`use_responses_lite`)**: If you experience an error when selecting an Antigravity model in Codex, ensure you are running this bridge where `use_responses_lite` is set to `false`.
- **Port Conflicts**: If port `17842` is occupied by another process, specify `PORT=17845 node src/cli.mjs serve` and update setup accordingly.
- **Authentication Expired**: If AGY returns an authentication error, re-run `agy auth` in your browser to refresh your Google session.

---

## Compliance & Disclaimer

`codex-bridge-antigravity` is an independent, non-commercial personal productivity tool designed for individual developers to connect their own locally authenticated tools on `localhost`.

- This project is not affiliated with, endorsed by, or sponsored by OpenAI or Google.
- Requests sent through this bridge use your own local authentication and existing account quotas.
- Not intended for multi-tenant hosting, public proxying, commercial resale, or unauthorized model distillation.

---

## License

[MIT](LICENSE) © 2026 Jakevin
