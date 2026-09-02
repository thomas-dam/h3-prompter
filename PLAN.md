# Unified Prompt Studio implementation

The app combines the original h3-prompt-tool graphical style, this repository's provider/media/prompt backend, Krea's separate instruction set, and a video analysis workflow adapted from video-to-h3-prompt.

## Protected requirements

- Preserve the original navy/gradient/card/pill interface and two-column layout.
- Leave `/Users/lisa/src/h3-prompt-tool` untouched.
- Analyze the exact trimmed artifact that can be downloaded.
- Generate a prompt accompanying that clip (`<Video 1>`), for manual H3 or ComfyUI use.
- Never upload to or enqueue on H3/ComfyUI automatically.
- Preserve settings, Keychain credentials and the pre-existing Sharp upgrade.

## Implemented subsystems

- Shared H3, Video → Prompt and Krea UI, model settings and project controls.
- Accurate 2–15 second MP4 preparation, frame analysis, optional resampling, reviewed descriptions and reference-role adaptation.
- Matching clip/text/Markdown downloads with outdated-result guards.
- Versioned project persistence with atomic save and media restoration.
- Controlled-provider unit/integration/browser tests and real FFmpeg fixture checks.

## Validation boundary

Automated model responses validate application behavior, not live VLM accuracy. Actual prompt quality depends on the selected vision model and should be reviewed against the clip. ComfyUI compatibility is manual and workflow-specific; no ComfyUI service is contacted by the application or tests.

## Next phase: continuity between generated clips

### Confirmed direction — 2026-08-30

The objective is to make separately generated clips and camera angles connect more naturally when edited together after ComfyUI generation.

There are two required outcomes:

1. Develop an editable story from an idea or supplied script, then generate image prompts for its storyboard.
2. Generate coordinated H3 clip prompts that explicitly use a character sheet, storyboard images, or both as assigned references.

**User-confirmed workflow:** Story → storyboard prompts → generate/import images → **Human Control — review and assign references** → coordinated H3 clip prompts → manual ComfyUI generation.

Human Control is an explicit approval step, not an automatic model decision. After importing images, the user reviews/replaces them, confirms the scene/clip order, selects panels or crops, and assigns each reference to a character, clip and role. Model suggestions remain unapproved until accepted. Coordinated H3 prompt generation requires this approval. Subsequent changes to the approved story, clip order, images, crops or reference assignments require renewed review of the affected plan and mark dependent prompts as outdated.

- No Claude Code integration, runtime, installation, or dependency.
- Use the existing LM Studio connection and user-selected local model. OpenRouter remains an explicitly selected alternative; never switch to cloud automatically.
- Adapt useful storyboard guidance into app-owned instructions and editable data. Do not install or execute the upstream skill. Retain attribution/license for any adapted material.
- Keep the existing graphical style and manual prompt/reference export. No automatic ComfyUI calls or generation queue.

### Implemented first workflow — 2026-08-30

1. **Develop the story.** Accept an idea or existing story/script. The selected LLM proposes an editable story, characters, scenes and action sequence. The user reviews/edits it before requesting image prompts; formal Human Control approval comes after importing images and assigning references, before H3 clip generation. Preserve supplied dialogue verbatim.
2. **Establish shared scene details.** Save character identities, wardrobe, setting, lighting, props, aspect ratio, and spatial relationships. Keep these stable across image and clip prompts unless the user requests a change.
3. **Plan editable clips and angles.** Each card represents one exported H3 generation prompt, with duration, camera position/framing, visible subjects, action, dialogue, and start/end state. Prefer one camera angle per clip initially. A shot inside a clip is not automatically another generated clip.
4. **Write storyboard image prompts.** Produce a prompt for each planned panel/scene, with an optional combined storyboard-sheet prompt that specifies panel order and layout. Each panel depicts a selected still moment, not an entire action sequence. Repeat the approved identity and scene details where needed so exported prompts are independently usable. Keep these image prompts separate from H3 motion/dialogue prompts. The user generates the images in their chosen image workflow and uploads the results; this step does not automatically send work to ComfyUI or an image service.
5. **Human Control — review and assign references.** Show the imported images alongside the planned clips for explicit human review. The user chooses which images to keep, replaces unsuitable results, confirms clip order, and approves the assignments before H3 prompt generation. Allow a multi-angle character sheet, individual character views, a complete storyboard sheet, or separate storyboard panels. Link each character reference to its subject; link each storyboard panel to its scene/clip. Offer explicit panel selection/cropping with an exportable image, rather than relying on ambiguous instructions about a panel embedded in a grid. A vision model may propose mappings, but cannot approve them. Support character-sheet-only, storyboard-only, and combined use.
6. **Review each connection.** Mark whether it is a continuation, a cut to another angle, or an intentional scene/time change. For a continuation, compare endpoint pose, position and action phase. For an angle cut, compare scene geometry, camera side, eyelines, screen direction and action continuity; do not demand identical images from different viewpoints. Make suggestions editable and preserve intentional exceptions.
7. **Generate coordinated H3 prompts.** Build each prompt from the approved story/common scene, its clip card, assigned images and its neighboring connections. Use the existing H3 mode-specific formatting/audit. Keep reference labels local to each export and attach a reference mapping. Distinguish appearance references from composition/pose references and first/last-frame constraints. Do not add dialogue, new cuts or reference-derived facts without approval.
8. **Export manually.** Copy/download numbered storyboard-image prompts, H3 clip prompts, the shot list, selected reference images/crops, reference mapping, and editing notes. The user imports prompts and references into their existing ComfyUI workflow.
9. **Review actual renders (later increment).** Let the user upload generated clips to compare neighboring endpoints and select useful frames. A vision-capable model can flag visible mismatches for review. Offer endpoint-image export for a suitable continuation workflow; an angle change may need a different view rather than reuse of the exact previous frame. Changes to later prompts require approval and create revisions.

### Reference semantics

- **Character sheet:** identity, appearance, clothing and applicable view. Multiple views depict the same subject, not multiple people in the generated scene. Do not copy the sheet's grid, labels or neutral background into the target scene unless explicitly requested.
- **Storyboard panel:** scene composition, camera angle, blocking and selected pose/action moment. A still image alone does not establish unseen motion or exact temporal progression; the approved story and clip card supply those.
- **Combined:** make the assignment explicit, for example a character reference supplies appearance while the linked storyboard panel supplies framing and blocking. If they disagree, show the conflict and let the user choose which traits to retain.
- **Start/end frame:** a separate intentional role supported by the chosen H3 mode, never inferred merely because an image is called a storyboard panel. A complete collage must not accidentally become the first frame of a full-screen video.
- Save original sheets, selected panel crops and their mappings with the project. Editing story, clip order or reference assignments marks dependent prompts as outdated without discarding prior revisions.

### Scope and safeguards

The first implementation is in `public/storyboard.js`, shared `public/storyboard-state.js`, `src/lib/storyboard.js`, and `src/storyboard_routes.js`. Server-held approvals are bound to a canonical plan/media fingerprint and session; model responses cannot supply approved references or approval tokens. Saved projects preserve drafts, references, crops and prompt history but require renewed human approval when reopened. The returned-render feedback step remains a later increment.

- First implementation includes both goals: story development, storyboard image prompts, character-sheet/storyboard reference assignment and panel crops, scene continuity fields, clip cards, connection review, coordinated H3 prompts, project save/restore and manual export.
- Next increment: user-uploaded render comparison, chosen endpoint frames and targeted prompt revisions. No automatic stitching or full video editor.
- Keep observed video descriptions separate from creative plans. A proposed cut must never silently change the existing prepared clip or claim it occurred in the source.
- Separate concrete checks (missing references, invalid timing) from model suggestions (action density, composition, performance). Upstream experimental thresholds are not mandatory format rules.
- Preserve existing H3, Video and Krea behavior, local-first privacy, cancellation, revision history and outdated-result guards.
- The existing Krea reference mode is deliberately style-only. Storyboard identity/composition references need an explicit new path with their own instructions; do not silently reinterpret existing Krea references as character identity.
- Tests should cover both story-to-image-prompt and reference-to-H3-prompt flows, required human approval and its invalidation after changes, sheet/panel mappings, single-subject identity across views, reference remapping, persisted crops, outdated-result handling, rejected automatic cloud fallback, and continuity state flowing into neighboring prompts. Actual visual improvement must be assessed using user-provided ComfyUI outputs; prompt checks alone cannot prove it.
