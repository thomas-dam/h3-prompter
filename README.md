# H3 Prompt Writer

Standalone macOS web app for writing MiniMax H3 video prompts with local or
cloud Qwen models. No ComfyUI, no GPU bindings, no Python — just Node.js,
`ffmpeg`, and a Qwen model running locally or in the cloud.

## What it does

You give it a creative brief, optional image/video/audio references, and
mode + aspect ratio + duration. It uses the official MiniMax H3 prompt-writing
guides and a Qwen model to produce a structured H3 prompt you can paste into
your H3 workflow.

Supports all five H3 modes: **T2VA**, **I2VA**, **FL2VA**, **L2VA**, and
**Reference**.

## Prerequisites

Install these before you start:

| Requirement | Why | Install |
|-------------|-----|---------|
| **Node.js 22+** | Runs the app | `brew install node` or download from nodejs.org |
| **ffmpeg** (includes `ffprobe`) | Video frame extraction and contact sheets | `brew install ffmpeg` |
| **A Qwen model** | The model that writes prompts | See provider setup below |

Verify your environment:

```sh
node --version   # v22 or higher
ffmpeg -version  # any recent version
```

That's the whole checklist. There's no GPU, CUDA, or Python stack to set up —
the model runs in LM Studio or OpenRouter, not in this app.

## Quick start

```sh
git clone git@github.com:thomas-dam/h3-prompter.git
cd h3-prompter
npm install
npm start
```

Open <http://127.0.0.1:4567> in your browser. You're ready to write prompts.

## Provider setup

Pick one (or switch between them anytime in the UI).

### LM Studio (local, free)

1. Download and open [LM Studio](https://lmstudio.ai/).
2. Download a Qwen model (e.g. `qwen3-235b-a22b-2507` — pick one that fits
   your machine).
3. Start the local server: in LM Studio, go to the **Developer** tab and
   click **Start Server**. It listens on `http://127.0.0.1:1234` by default.
4. In H3 Prompt Writer's **Settings** panel, choose **Provider: LM Studio**
   and type the model ID exactly as LM Studio shows it.

No API key, no internet — everything stays on your machine.

### OpenRouter (cloud, paid)

1. Create an account at <https://openrouter.ai/> and create an API key.
2. In H3 Prompt Writer's **Settings** panel, choose
   **Provider: OpenRouter**.
3. Paste your API key and click **Save**. The key is stored in the macOS
   Keychain — it never touches disk in plaintext.
4. Type the Qwen model ID (e.g. `qwen/qwen3-235b-a22b-2507`). Check the
   exact ID on <https://openrouter.ai/models>.

## Using the app

### The basic flow

1. **Pick a mode** (top of the Creative Brief panel):
   - **T2VA** — text to video, no references
   - **I2VA** — one start image, video develops forward
   - **FL2VA** — first and last image, model fills the motion between
   - **L2VA** — one last image, model imagines what leads up to it
   - **Reference** — up to 9 images, 3 videos, 3 audio references; full
     six-section reference prompt

2. **Set aspect ratio and duration** (1–20 seconds).

3. **Write a creative brief.** Plain English, up to 2,000 characters. Say
   what you want to see and hear. If you uploaded references, mention their
   roles here (e.g. "Use Video 1 only for motion").

4. **Upload references** (if your mode takes them). Drag files into the
   Media panel or click **Browse**. Images, videos, and audio are accepted
   per the mode's limits. Videos are turned into ordered contact sheets
   automatically — you'll see the preview in the panel.

5. **Click Generate.** The prompt streams in as the model writes. When it
   finishes, the prompt audit runs automatically and tells you whether the
   output passes the official format checks.

6. **Copy** the result into your H3 workflow.

### Refining

After a prompt is generated, the **Refine** row appears. Type a revision
instruction (e.g. "make the opening brighter", "add a second shot at 3
seconds") and click **Refine**. The model rewrites the prompt using your
current one plus the instruction.

### Advanced settings

Click **Advanced** in the Settings panel to expose:

- **Context** — Auto picks based on the model, or force 8K / 16K / 24K.
  Larger context lets you use more references and a longer brief.
- **KV cache** — Auto, Q8, or F16. Affects LM Studio's memory use; leave on
  Auto unless you know why you're changing it.
- **Thinking** — enables Qwen's thinking mode. Uses more tokens and time
  but often produces better prompts. Not available at 8K context.
- **Seed** — set a number for reproducible runs, or leave blank for random.

### The prompt audit

For Reference mode, the app checks the generated prompt against the
official MiniMax format rules after every generation:

- All six required sections present and in order
- `[Shot 1]` marker and summary task label present
- Valid timestamps (MM:SS.mmm, within duration)
- No leaked internal language ("contact sheet", "sampled frames")
- Dialogue has stable speaker IDs
- Reference tags match what you uploaded

If the audit finds problems, it tries one **narrow repair** pass — a
targeted correction that fixes only the listed violations without rewriting
the rest. If the repair would change the dialogue or reference inventory,
it's rejected and the original draft stays. The audit result is shown in
the UI after generation.

## API

All endpoints live under `/h3studio`. The most useful ones:

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/h3studio/status` | App state |
| `GET` | `/h3studio/guides` | List vendored MiniMax guides |
| `GET` | `/h3studio/guides/:mode` | Guide for a mode |
| `GET` | `/h3studio/system-prompt/:mode` | Default system prompt for a mode |
| `POST` | `/h3studio/assemble` | Preview the assembled request |
| `POST` | `/h3studio/generate` | Generate a prompt (SSE stream) |
| `POST` | `/h3studio/cancel` | Cancel the active generation |
| `POST` | `/h3studio/refine` | Refine an existing prompt (SSE stream) |
| `POST` | `/h3studio/media/upload` | Upload reference files (multipart) |
| `GET` | `/h3studio/media` | List session media |
| `GET` | `/h3studio/media/manifest` | Validated manifest for a mode |
| `GET` | `/h3studio/media/:id/content` | Serve original / preview / sheet / frame |
| `DELETE` | `/h3studio/media/:id` | Remove an asset |
| `DELETE` | `/h3studio/media` | Clear a session |
| `POST` | `/h3studio/media/reorder` | Reorder assets |
| `GET/PUT` | `/h3studio/settings` | Read / update non-secret prefs |
| `POST` | `/h3studio/settings/openrouter-key` | Store key in Keychain |
| `DELETE` | `/h3studio/settings/openrouter-key` | Delete key from Keychain |

Errors are structured with stable codes:

```json
{ "error": { "code": "INVALID_DURATION", "message": "Duration must be between 1 and 20 seconds." } }
```

## Running the tests

```sh
npm test
```

Unit tests cover request assembly (all five modes), validation limits,
prompt audit decisions, and the narrow-repair message construction. There's
no browser automation and no integration suite — those need a live model.

## Troubleshooting

**`ffmpeg: command not found`** — install it (`brew install ffmpeg`) and
restart the app. The app doesn't bundle ffmpeg; it expects it on your PATH.

**LM Studio returns `ECONNREFUSED`** — the local server isn't running. Open
LM Studio → Developer tab → Start Server, then try again.

**OpenRouter returns `401 Unauthorized`** — your API key is wrong, expired,
or wasn't saved. Re-enter it in Settings and click **Save**.

**OpenRouter returns `insufficient credits` or `rate limit`** — check your
account at <https://openrouter.ai/>.

**Generation hangs forever** — click **Cancel**. If the app is completely
stuck, restart it. Note: session media is ephemeral and won't survive a
restart — you'll need to re-upload references.

**The audit says "needs review" but the prompt looks fine** — the audit is
strict on purpose. Read the listed issues; if you disagree, ignore it and
use the prompt as-is. The audit never blocks the output, it only flags.

**Sharp install fails on Apple Silicon** — make sure Xcode Command Line
Tools are installed: `xcode-select --install`.

## How data is stored

- **Session media** (uploaded images, videos, audio, generated previews and
  contact sheets) lives in an OS temp directory (`$TMPDIR/h3-promptwriter/`).
  It's wiped when the app starts and abandoned if the app crashes. No
  persistence, no database.
- **Settings** (provider, model IDs, advanced prefs) are stored in a JSON
  file at `~/.config/h3-promptwriter/settings.json`.
- **OpenRouter API key** is stored in the macOS Keychain under the service
  name `h3-promptwriter`. It never touches the filesystem.

## What this app is not

- It does not run MiniMax H3 itself. It writes prompts you paste into your
  H3 workflow.
- It does not hear audio. Audio files are declared as `<Audio N>` references;
  their role must come from your brief.
- It does not package ffmpeg. You install it yourself.
- It does not support Windows or other model families in v1. The audit and
  chat-template handling are tuned for Qwen.

## License

See the upstream project for guide and code provenance. The MiniMax H3
prompt-writing guides are vendored verbatim from the official
`MiniMaxAI/MiniMax-H3` Hugging Face repository at revision
`bfc8ed0353f5a9733be73e6b2c98ec0948195b86`.