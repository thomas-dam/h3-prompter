# Standalone H3 Prompt Writer

## Summary

Standalone macOS Node.js/Express web app for editing MiniMax H3 prompts using
local LM Studio or cloud OpenRouter. No ComfyUI dependency.

Qwen-only. The app assumes a Qwen chat template and Qwen token behavior
throughout. The user types the specific Qwen model ID manually (e.g.
`qwen3-235b-a22b-2507`); no curated list, no probing, no capability detection.
Audit and repair rules are tuned for Qwen and may be wrong for other model
families.

## Provider Model

- **LM Studio** — user runs their own server, enters the Qwen model ID. App
  sends requests to `http://127.0.0.1:1234/v1/chat/completions` using the Qwen
  chat template. No probing, no capability detection.
- **OpenRouter** — user enters their API key (stored in macOS Keychain via
  `security` command) and Qwen model ID. App sends requests to
  `https://openrouter.ai/api/v1/chat/completions`.

Provider is explicit per request. Never fall back automatically.

## Core Features

- Five MiniMax H3 modes: T2VA, I2VA, FL2VA, L2VA, Reference
- Image references, video references (contact sheets via FFmpeg), audio
  references (uploaded, stored, declared as `<Audio N>`)
- Creative brief, aspect ratio, duration controls
- Vendored MiniMax official guides
- Prompt assembly, generation, refinement, cancellation via SSE + AbortController
- Post-generation prompt audit (Qwen-aware: check for chat-template artifacts,
  leaked special tokens, missing/declared reference tags, mode-specific shape)
  and optional narrow repair (mechanical fixes only — strip, insert, truncate;
  never rephrase)
- Advanced settings: system prompt override, context profile, thinking toggle, seed

## What We Drop from the Upstream

- All VRAM/memory estimation and GPU management
- Gemma-specific token-count heuristics and control-token stripping in
  `final_text()` (replaced by Qwen-aware audit/repair)
- Model discovery and setup catalog
- `llama-cpp-python` / PyAV / PyTorch dependencies
- Browser/Playwright test suite

## Stack

- Node.js 22, ES modules, Express
- Vanilla JS browser UI (port from upstream web/), no build tool
- Sharp for image normalization
- `ffmpeg` on PATH (user-installed; documented prereq) for video frame
  extraction and contact sheets — not packaged
- macOS Keychain for the OpenRouter key
- JSON settings file for non-secret preferences
- Ephemeral session media in an OS temp dir; wiped (or abandoned) on app
  restart. No persistence, no cleanup logic. If the app crashes, the user
  starts fresh.

## API Endpoints (under `/h3studio`)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/h3studio/status` | App state |
| GET | `/h3studio/guides` | List guides |
| GET | `/h3studio/guides/:mode` | Guide for mode |
| POST | `/h3studio/assemble` | Preview prompt assembly |
| POST | `/h3studio/generate` | Generate — SSE streaming |
| POST | `/h3studio/cancel` | Cancel via AbortController |
| POST | `/h3studio/refine` | Text-only refinement |
| POST | `/h3studio/media/upload` | Upload image/video/audio |
| GET | `/h3studio/media` | List session media |
| GET | `/h3studio/media/manifest` | Validated manifest for mode |
| GET | `/h3studio/media/:id/content` | Serve original/preview/sheet/frame |
| DELETE | `/h3studio/media/:id` | Remove asset |
| DELETE | `/h3studio/media` | Clear session |
| POST | `/h3studio/media/reorder` | Reorder assets |
| GET/PUT | `/h3studio/settings` | Non-secret prefs (redacted) |
| POST | `/h3studio/settings/openrouter-key` | Set/replace key |
| DELETE | `/h3studio/settings/openrouter-key` | Delete key |

Structured errors with stable codes (invalid media, provider unavailable,
auth failure, context overflow, busy, cancelled).

## Testing

Manual human testing. Unit tests only for the critical ported logic:

- Request assembly (all five modes)
- Validation limits
- Prompt audit and repair decisions

No browser automation, no contract tests, no integration test suite.

## v1 Out of Scope

- No database, user accounts, Electron, packaging
- No direct GGUF bindings or native audio analysis
- No automatic fallback between providers
- No Windows support (portable architecture)