# H3 + Krea Prompt Studio

A local macOS web app combining H3 prompt writing, video analysis/trimming, and Krea 2 image prompts. It keeps the visual style of the local `h3-prompt-tool` and uses this project's Node backend.

**It prepares prompts and reference clips. It never sends work to H3 or ComfyUI, uploads to their servers, or queues generation.**

## Start

Requires Node.js 22+, FFmpeg/FFprobe on PATH, and an LM Studio or OpenRouter model. Image and video analysis require a model that accepts image inputs.

```sh
npm install
npm start
```

Open **http://127.0.0.1:4567**. The server binds to loopback by default. `PORT` changes the port; `HOST` deliberately changes the bind address. Do not expose it to an untrusted network: this personal application has no account/authentication system.

### LAN and Tailscale access on m1

- **LAN:** http://192.168.1.178:4567 (the address may change with DHCP).
- **Tailscale HTTPS:** https://m1.typhon-kelvin.ts.net:4567 — requires access to this machine through your tailnet.

The app listens on all IPv4 interfaces using `npm run start:lan`. Tailscale Serve proxies HTTPS port 4567 to `http://127.0.0.1:4567`; other Tailscale sites are unchanged. This uses **Serve, not Funnel**, with no public-internet route configured.

The running app uses the tmux session `h3-promptwriter` and logs to `.cache/lan-server.log`. It survives terminal closure, but **does not auto-start after a Mac reboot**. From this project directory, start it again with:

```sh
mkdir -p .cache
tmux new-session -d -s h3-promptwriter -c "$PWD" 'npm run start:lan >> .cache/lan-server.log 2>&1'
tailscale serve --bg --https=4567 http://127.0.0.1:4567
```

Stop the app with `tmux kill-session -t h3-promptwriter`. Remove only its HTTPS route with `tailscale serve --https=4567 off` (do not reset all Serve routes).

Use trusted LAN/tailnet devices only: there is no login, and projects, model settings and model usage are shared. HTTP LAN access is unencrypted; prefer the Tailscale HTTPS link for entering API keys. Prompt copying falls back to browser copy support on HTTP; if blocked, the app selects the text and gives manual-copy instructions. Save projects before restarting the server; temporary unsaved media is cleared at startup.

### Shared model settings

Open **Model settings** and choose LM Studio or OpenRouter.

- **LM Studio:** enter its base URL including `/v1`, for example `http://127.0.0.1:1234/v1` or your LAN server's address. Save, then use **Refresh models / connection**. Choose from **Available LM Studio models** or type a model ID manually; save settings to keep the choice. The dropdown lists every ID reported by the server, without filtering by the current selection. Existing settings are preserved; no LAN address is silently substituted.
- **OpenRouter:** enter the model ID and save the API key. Keys remain in macOS Keychain. Cloud requests send the brief and prepared visual inputs to the selected provider. There is no automatic cloud fallback.
- H3 context, KV cache, thinking and seed controls remain available. Video analysis uses bounded batches with thinking off. Availability in the model list does not prove image support; unsupported image requests fail with an actionable model error.

## Storyboard: story to connected H3 clips

**Story → storyboard prompts → generate/import images → Human Control → coordinated H3 clip prompts → manual ComfyUI generation.**

Open **Storyboard** in the top navigation. It uses the same selected model and provider as the other pages. There is no Claude Code integration or dependency, and no automatic fallback from LM Studio to OpenRouter. Text planning can use a text model; H3 prompting with the uploaded references needs a vision-capable model.

1. **Develop your story.** Enter an idea or paste a script, choose 1–8 draft clips and a frame shape, then develop the draft. Review/edit the story, shared scene and characters. You can also enter a plan manually, with up to 12 clips.
2. **Plan clips and angles.** Edit each clip's camera, action, dialogue, duration, start/end state and connection to its predecessor. Clip duration is 2–15 seconds. Reorder cards as needed; check the new connections afterward. A cut to another angle should preserve scene/action continuity, not require identical framing.
3. **Write image prompts.** Use the reviewed story to generate one still-image prompt per clip, plus a combined storyboard-sheet prompt. Copy or download them, generate the images in your chosen image tool, and import the results. The app does not generate or submit images itself.
4. **Import and review references.** Choose character sheets, individual character views, full storyboard sheets or single panels. Use **Select panel / crop** to drag a region, enter percentages or select a grid cell. Crops become separate downloadable PNGs; originals are untouched. The library holds up to 64 images (12 uploads at a time).
5. **Human Control.** Assign images and their specific roles to every clip. Character references name a character present in that clip. Composition references guide framing/blocking/pose; use notes to identify a panel in a full sheet or resolve conflicting traits. Review the neighboring start/end states and confirm the checkbox, then **Approve this plan**. Model output cannot grant approval.
6. **Generate H3 clip prompts.** Generate all clips, or only the selected clip. Review/edit each result, copy/download it, or download the complete Markdown prompt pack and reference mapping. Each mapping offers image downloads with clip/reference-numbered filenames. Load them manually into your compatible ComfyUI workflow; prompt text does not contain the image files.

### Reference modes and approval

- **Ref2VA:** up to 9 assigned character/composition images per clip. Character sheets represent one subject from different views, not several people; storyboard grids and labels should not appear in the target video.
- **I2VA / L2VA:** exactly one explicitly assigned first/last-frame panel.
- **FL2VA:** exactly one first-frame and one last-frame panel, exported in that order. Full sheets cannot serve as endpoint frames. Use Ref2VA when combining character and composition references.
- Any change to the reviewed story, characters, clip plan/order, images, crops or reference assignments requires human review again. Previous prompts remain, but changed-plan outputs cannot be copied/exported as current results. Reference uploads also invalidate approval even if not yet assigned.
- Approval is enforced by the server, tied to the session, complete plan and media, and expires after 24 hours. Reopening a saved project or restarting the app requires another review. Unchanged saved outputs can be exported after reapproval without regeneration.
- Saved projects include the storyboard, image prompts, sheets/crops, reference assignments, H3 outputs and up to 30 prior versions per clip. A failed/cancelled batch keeps the previous completed results. Storyboard image prompts become outdated when the underlying story/clip plan changes.

Connection notes are suggestions for human review, not proof that generated videos will match. Inspect your ComfyUI renders. Automatic stitching, returned-render comparison and endpoint-frame feedback are outside this first implementation. The existing Video → Prompt workflow still describes the actual prepared clip; creative storyboard plans do not alter it. Krea's existing reference mode remains style-only.

## H3 Prompts

Choose T2VA, I2VA, FL2VA, L2VA, or Ref2VA. Enter a brief, duration, frame shape and optional visual style. Add the required media and describe what each reference should contribute. FL2VA image ordering is first frame then last frame; use the arrow buttons to reorder.

Generate, review/edit, copy/download, or refine the prompt. Ref2VA runs the format audit and at most one narrow repair. Missing/invented reference tags or failed explicit reference constraints now reject the generated draft if repair fails; they cannot be returned as a successful prompt. Quality/length warnings remain advisory. A cancelled or failed generation retains the previous successful prompt. Custom H3 system instructions remain optional.

Ref2VA references may be supplied **directly to H3**; uploading them to this prompt tool is optional. For example: “Make the girl in <Picture 1> act like the girl in the uploaded video.” The prompt should bind analyzed appearance to `<Picture 1>` and the complete performance to `<Video 1>`, without inventing what the unseen video contains. Name another source explicitly, such as `<Video 2>`, if needed. Keep the official six-section format and useful image details, along with the user's requested shots, camera work, scene and sound. Word guidance is not permission to invent a competing performance. Local uploads provide observations but are not a prerequisite for declaring H3 reference roles. Refinement retains the original brief and actual visual inputs; an earlier generated draft is not source evidence. The checks validate reference binding, not the semantic correctness of every generated sentence; review the output.

Ordinary H3 mode retains the existing 1–20 second target duration range. Reference uploads allow up to nine images, three videos and three audio files, with twelve assets total; reference video/audio must be 2–15 seconds.

## Video → Prompt

1. Upload a video (up to 1 GB). Select a **2–15 second** range with start/end fields or playhead buttons. A qualifying short file may use its entire duration.
2. **Prepare clip** creates a new MP4. The original stays untouched. The export uses H.264 video, AAC audio when present, accurate decoded trim boundaries, upright orientation, and clip-relative timestamps.
3. **Analyze clip** observes that exact prepared artifact, using 0.2-second samples in overlapping batches of six. Uncertain regions may receive 0.1-second resampling, capped at 100 observations per analysis. This can require several model requests.
4. Review and edit the shot/action/camera description. The app does not listen to or transcribe audio; its presence is metadata, not evidence of speech or music content.
5. Optionally describe changes and upload replacement images. Assign each an explicit role: subject appearance, setting, or visual style. No unspecified traits should transfer.
6. Generate the accompanying Ref2VA prompt. **`<Video 1>` means the prepared/exported clip**, not the full original. Image labels identify the replacement images in displayed order.
7. Download the clip, copy/download the prompt, and optionally download the Markdown analysis. Matching filenames keep them together.

The exported clip retains audio when present. **Use the clip's audio in the H3 prompt** separately enables its explicit reuse relationship. With that unchecked, the prompt ignores the source soundtrack.

Changing the trim makes the prepared clip and prompt outdated. Prepare and analyze the new selection before generating again. Changing the reviewed analysis or replacement choices also disables copying/exporting the old prompt until regenerated. Returning to the exact previous selection may reuse its still-matching prepared artifact.

### Manual ComfyUI workflow

Download the MP4, load it into the video input of **your existing H3-capable ComfyUI workflow**, load any replacement images in Picture order, and paste the prompt into its text input. The app does not generate workflow JSON or assume particular custom nodes. Test compatibility with your own workflow; no ComfyUI instance is touched by app tests.

## Krea 2

- **Explore:** leave creative room.
- **Direct:** follow a defined art direction.
- **Reference-led:** derive visual style from up to six images without copying their subjects.

Medium, composition, lighting, palette, must-keep details, chips and example inputs are retained. Generate a single paragraph, edit/refine it, and copy/download it. Krea uses its own prompt instructions, not the H3 audit.

## Saved projects

Use **Saved projects** to name and save the current workspace. A project includes all three pages' fields, uploaded media, prepared clips, reviewed analysis, prompt outputs and up to 30 prompt revisions per page.

- Save is explicit. Unsaved changes trigger a browser leave warning.
- Open restores media into a new temporary session; it works after app restart.
- Saves copy media and commit a versioned manifest atomically. A failed save leaves the previous saved version intact.
- Delete removes only app-managed project copies. It does not delete the original files you uploaded or the currently open draft.
- There is no cloud project synchronization.

Storage:

| Data | Location |
|---|---|
| Saved projects | `~/.local/share/h3-promptwriter/projects/` |
| Temporary media/previews | OS temp directory, `h3-promptwriter/` (reset at startup) |
| Non-secret settings | `~/.config/h3-promptwriter/settings.json` |
| OpenRouter key | macOS Keychain service `h3-promptwriter`, account `openrouter` |

Tests use isolated paths through `H3_DATA_DIR`, `H3_CACHE_ROOT`, and `H3_SETTINGS_PATH`. These overrides are also useful for portable local data storage. Avoid starting two app processes against the same data/cache roots.

## APIs

Existing `/h3studio` status, provider-status, guide, assembly, generation/refinement, cancellation, media, and settings routes remain. The UI labels Reference mode as Ref2VA; the ordinary API retains `mode: "Reference"`.

New routes:

| Method | Route | Purpose |
|---|---|---|
| POST | `/h3studio/clips/source` | Adopt a validated uploaded source into a workspace |
| POST | `/h3studio/clips/prepare` | Prepare a selected source segment (SSE) |
| POST | `/h3studio/clips/analyze` | Analyze a prepared clip (SSE) |
| POST | `/h3studio/video/generate` | Generate/refine its Ref2VA prompt (SSE) |
| POST | `/kreastudio/generate`, `/kreastudio/refine` | Krea prompt generation/refinement (SSE) |
| POST | `/h3studio/storyboard/develop` | Develop an editable story/clip plan (SSE) |
| POST | `/h3studio/storyboard/images` | Write individual and combined-sheet image prompts (SSE) |
| POST | `/h3studio/storyboard/crop` | Create a panel from normalized x/y/width/height coordinates (SSE) |
| POST | `/h3studio/storyboard/approve`, `/h3studio/storyboard/revoke` | Explicit human review / reopen review |
| POST | `/h3studio/storyboard/generate` | Generate approved clip prompts; optional `clip_id` selects one (SSE) |
| GET/POST | `/h3studio/projects` | List or save projects |
| POST | `/h3studio/projects/:id/open` | Restore a saved project |
| DELETE | `/h3studio/projects/:id` | Delete a saved project |

The media upload route additionally accepts workspace modes `VideoSource`, `Video` (replacement images/prepared clip), `Krea`, and `Storyboard` (image library). Media content supports HTTP range requests for playback and `download=1` for downloads. Storyboard image downloads also accept a safe `download_name` for matching the exported reference map.

Clip requests identify the session and prepared/source asset IDs; video generation additionally requires its current analysis ID and optionally edited analysis text, image-role mapping, and audio opt-in. One model/media operation runs at a time across all pages. SSE events use `phase`, `delta`, `complete`, `error`, and `cancelled`.

## Verification

```sh
npm test
npm run test:browser
```

Backend tests generate actual FFmpeg fixtures and verify exact trim starts, rotation, codecs, audio synchronization, silence, cancellation, project recovery, export guards, and HTTP playback/downloads. They open temporary loopback servers.

Browser tests use headless Chromium, actual uploads/trimming/downloads and controlled model responses. They verify desktop/mobile interactions and save screenshots under `.cache/`. They do **not** evaluate live model quality. The browser test uses Playwright's installed Chromium, an explicit `H3_TEST_BROWSER` executable, or an existing cached macOS headless Chromium. If none is installed, run `npx playwright install chromium --only-shell`.

The original `h3-prompt-tool` is unchanged. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for local interface and upstream workflow provenance.
