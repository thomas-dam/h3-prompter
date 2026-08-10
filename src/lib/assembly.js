import { MODE_GUIDES, guideForMode, loadGuide, referenceBaseExcerpt } from "./guides.js";
import { resolveSystemPrompt, SystemPromptError } from "./system_prompts.js";

export const ASPECT_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"]);
const CAPABILITY_BY_TYPE = { image: "images", video: "video_frames", audio: "audio" };

export class AssemblyError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.message = message;
    this.details = details;
  }
}

function _requiredText(body, key, label) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new AssemblyError("INVALID_REQUEST", `${label} is required.`, { field: key });
  }
  return value.trim();
}

function _mediaLine(asset) {
  let detail = asset.type;
  if (asset.duration !== undefined && asset.duration !== null) {
    detail += `, ${asset.duration}s`;
  }
  if (asset.type === "video") {
    const times = (asset.frames || []).map((f) => `${f.timestamp}s`).join(", ");
    if (times) detail += `, sampled frames at ${times}`;
  } else if (asset.type === "audio") {
    detail += ", not analyzed by the local model; role must come only from the user's brief";
  }
  return `${asset.reference || asset.filename}: ${asset.filename} (${detail})`;
}

function _effectiveSystemPrompt(body, mode) {
  try {
    const { prompt, custom } = resolveSystemPrompt(mode, body.system_prompt_override);
    return [prompt, custom];
  } catch (error) {
    if (error instanceof SystemPromptError) {
      throw new AssemblyError(error.code, error.message);
    }
    throw error;
  }
}

function _guideMessages(mode, systemPrompt) {
  const guide = guideForMode(mode);
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", name: "prompt_studio_system_prompt", content: systemPrompt });
  }
  messages.push({ role: "system", name: "official_minimax_h3_guide", content: guide.content });
  if (mode === "Reference") {
    messages.push({ role: "system", name: "official_minimax_h3_shared_base_rules", content: referenceBaseExcerpt() });
  }
  return messages;
}

function _finalContract(mode, taskText) {
  if (mode !== "Reference") {
    const modeRule = {
      T2VA: "Preserve any explicit continuous-camera or no-cut instruction instead of introducing an unsupported cut.",
      I2VA: "Separate facts visible in the first frame from newly requested space or action revealed after it.",
      FL2VA: "Prioritize exact endpoint geometry and a continuous state/camera path between the first and last frames.",
      L2VA: "Invent only the minimum compatible preceding state needed to reach the final frame; do not infer a named location or period without evidence.",
    }[mode];
    return (
      `Final grounding check: ${modeRule} ` +
      "If the brief does not explicitly request non-diegetic music, return N/A for non_diegetic_music. " +
      "Return only the complete final MiniMax H3 prompt."
    );
  }
  const explicitEdit = /\b(?:edit(?:ing)?|continue|continuation|extend|remix|re-cut)\b.{0,40}\bvideo\b|\bvideo\s+editing\b/is.test(taskText);
  const taskClassification = explicitEdit
    ? "source-video editing or continuation; scale detailed_description with source complexity"
    : "reference generation, not keyframe completion or source-video editing";
  return (
    `Final request classification: ${taskClassification}. ` +
    "Treat every explicitly assigned reference role as exclusive unless the user asks that reference to contribute " +
    "additional traits; 'only' and 'solely' emphasize this rule but are not required. Unspecified target environment, lighting, " +
    "composition, camera treatment, and atmosphere may be designed as new target content, but never described as " +
    "facts derived from a reference. Do not add unsupported subject actions, dialogue, props, visible text, or an " +
    "invented ending. Music requested without an uploaded audio asset belongs only in non_diegetic_music and must " +
    "not create audio-reference or audio-reuse semantics. Prefer one continuous shot unless cuts are requested; " +
    "purposeful camera movement within that shot is allowed. Because H3 receives each source video itself, bind the " +
    "complete choreography, temporal order, pacing, and rhythmic character of a motion-only video without " +
    "reconstructing individual sampled gestures, named steps, poses, expressions, transitions, or a concluding move. " +
    "When a concrete visible object, character, scene, or effect from <Video N> is reused in the target, describe that " +
    "reused visual element through an appropriate <Subject N> while keeping <Video N> as its source provenance; do not " +
    "automatically create a separate subject for ordinary motion transfer. " +
    "If the brief does not explicitly request music, non_diegetic_music must be N/A. " +
    "Use the official detail budget for grounded target composition, placement, lighting, atmosphere, camera treatment, " +
    "supported action progression, and reference application; never pad solely to reach a word count. Return only the complete " +
    "prompt with all six required sections in the official order and no commentary outside the prompt."
  );
}

export function assembleRequest(body, { manifest }) {
  const mode = _requiredText(body, "mode", "Mode");
  if (!(mode in MODE_GUIDES)) {
    throw new AssemblyError("INVALID_MODE", "The selected MiniMax mode is not supported.");
  }
  const [systemPrompt, systemPromptCustom] = _effectiveSystemPrompt(body, mode);
  const brief = _requiredText(body, "creative_brief", "Creative brief");
  if (brief.length > 2000) {
    throw new AssemblyError("BRIEF_TOO_LONG", "Creative brief cannot exceed 2,000 characters.");
  }
  const aspectRatio = _requiredText(body, "aspect_ratio", "Aspect ratio");
  if (!ASPECT_RATIOS.has(aspectRatio)) {
    throw new AssemblyError("INVALID_ASPECT_RATIO", "The selected aspect ratio is not supported.");
  }
  const duration = body.duration_seconds;
  if (typeof duration !== "number" || typeof duration === "boolean" || duration <= 0 || duration > 20) {
    throw new AssemblyError("INVALID_DURATION", "Duration must be between 1 and 20 seconds.");
  }

  if (!manifest.valid) {
    throw new AssemblyError("INVALID_MEDIA_MANIFEST", "The media manifest is not valid.", manifest.violations);
  }

  const declaredReferences = manifest.assets.filter(
    (a) => a.type === "audio" || a.analysis_requested !== false,
  );
  const eligible = declaredReferences.filter((a) => a.type !== "audio");
  const mediaInputs = eligible.map((asset) => ({
    asset_id: asset.id,
    reference: asset.reference,
    type: asset.type,
    requires_capability: CAPABILITY_BY_TYPE[asset.type],
    frames: (asset.frames || []).map((frame) => ({ timestamp: frame.timestamp, content_url: frame.url })),
    content_url: asset.content_url,
  }));
  const references = declaredReferences.map(_mediaLine).join("\n") || "None";
  const userContent =
    `Mode: ${mode}\n` +
    `Duration: ${duration} seconds\n` +
    `Aspect ratio: ${aspectRatio}\n\n` +
    "Reference manifest (audio is not analyzed by the local model; derive its copy/reference role only from the user's words and do not invent its content):\n" +
    `${references}\n\n` +
    `Creative brief:\n${brief}\n\n` +
    _finalContract(mode, brief);

  const guide = guideForMode(mode);
  return {
    schema_version: 1,
    guide: _stripContent(guide),
    input: {
      mode,
      duration_seconds: duration,
      aspect_ratio: aspectRatio,
      creative_brief: brief,
      media_manifest: manifest,
    },
    media_inputs: mediaInputs,
    supporting_guides: mode === "Reference" ? [_stripContent(loadGuide("base"))] : [],
    system_prompt: { custom: systemPromptCustom, content: systemPrompt },
    messages: [..._guideMessages(mode, systemPrompt), { role: "user", content: userContent }],
  };
}

export function assembleRefinement(body, { manifest }, cachedObservation) {
  const mode = _requiredText(body, "mode", "Mode");
  if (!(mode in MODE_GUIDES)) {
    throw new AssemblyError("INVALID_MODE", "The selected MiniMax mode is not supported.");
  }
  const [systemPrompt, systemPromptCustom] = _effectiveSystemPrompt(body, mode);
  const currentPrompt = _requiredText(body, "current_prompt", "Current prompt");
  const instruction = _requiredText(body, "instruction", "Revision instruction");
  if (currentPrompt.length > 20000) {
    throw new AssemblyError("PROMPT_TOO_LONG", "The current prompt cannot exceed 20,000 characters.");
  }
  if (instruction.length > 2000) {
    throw new AssemblyError("INSTRUCTION_TOO_LONG", "The revision instruction cannot exceed 2,000 characters.");
  }

  const references = manifest.assets.map(_mediaLine).join("\n") || "None";
  const observation = cachedObservation?.trim() || currentPrompt;
  const guide = guideForMode(mode);
  const userContent =
    "Rewrite the current H3 prompt according to the revision instruction. " +
    "Return only the complete revised H3 prompt. Do not discuss the changes.\n\n" +
    `Reference manifest (text only; media is intentionally not attached):\n${references}\n\n` +
    `Cached first-pass observation:\n${observation}\n\n` +
    `Current prompt:\n${currentPrompt}\n\n` +
    `Revision instruction:\n${instruction}\n\n` +
    _finalContract(mode, currentPrompt + " " + instruction);

  return {
    schema_version: 1,
    guide: _stripContent(guide),
    input: {
      mode,
      current_prompt: currentPrompt,
      instruction,
      media_manifest: manifest,
    },
    media_inputs: [],
    supporting_guides: mode === "Reference" ? [_stripContent(loadGuide("base"))] : [],
    system_prompt: { custom: systemPromptCustom, content: systemPrompt },
    messages: [..._guideMessages(mode, systemPrompt), { role: "user", content: userContent }],
  };
}

function _stripContent(guide) {
  const { content, ...rest } = guide;
  return rest;
}