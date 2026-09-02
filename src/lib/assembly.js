import { MODE_GUIDES, guideForMode, loadGuide, referenceBaseExcerpt } from "./guides.js";
import { resolveSystemPrompt, SystemPromptError } from "./system_prompts.js";
import { motionReferenceRoles, motionRoleInstructions } from './reference_roles.js';
import { referenceTags } from './prompt_repair.js';

function h3References(brief, assets, roles = []) {
  return [...new Set([...assets.map(a => a.reference).filter(Boolean), ...referenceTags(brief), ...roles.map(r => r.reference)])];
}
function referenceInventory(assets, tags) {
  return [...assets.map(_mediaLine), ...tags.filter(tag => !assets.some(a => a.reference === tag)).map(tag => `${tag}: supplied directly to H3, not inspected by this prompt tool. Refer to this asset without inventing its visual content or actions.`)].join('\n') || 'None';
}

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

function _finalContract(mode, duration) {
  if (mode !== "Reference") {
    const end = Number.isFinite(duration) ? duration.toFixed(2) : 'the requested final';
    const modeRule = {
      T2VA: "Build the audiovisual timeline from the brief. Develop compatible visual and physical sound details without changing the requested action, subject counts, relationships, camera restrictions or ending. Begin with integrated_multimodal_description; no image-alignment instruction.",
      I2VA: "Picture 1 is the actual first frame, not merely an appearance reference. Analyze the attached image's composition, subjects and spatial relationships, then develop the requested action forward. First line exactly: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
      FL2VA: `Picture 1 is the first frame; Picture 2 is the final frame. Analyze BOTH attached images and describe a continuous physical path between them, reaching the second image at ${end} seconds. Favor one shot unless the user specifies cuts. First line: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the ${end}-second mark of the target video. Replace N with the actual final shot number.`,
      L2VA: `Picture 1 is the final frame, not the opening. Analyze its subjects and geometry, infer a compatible earlier state, and converge to that exact image at ${end} seconds. First line: How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the ${end}-second mark of the target video. Replace N with the actual final shot number.`,
    }[mode];
    return (
      `Selected mode instructions: ${modeRule}\n` +
      "After any alignment line and a blank line, write integrated_multimodal_description, overall_soundscape and non_diegetic_music in that order. [Shot 1] has no timestamp. Preserve the supplied dialogue and visible text exactly; do not invent speech. " +
      "If the brief does not explicitly request non-diegetic music, return N/A for non_diegetic_music. " +
      "Return only the complete final MiniMax H3 prompt."
    );
  }
  return `Selected mode instructions: Follow the official six-section Ref2VA format. Choose the summary task types from the actual requested reference relationships, not file presence. An explicitly assigned first/last frame is keyframe completion; appearance or motion guidance is reference generation; editing and continuation apply only when requested. When images are requested as reference frames or composition anchors, define their Picture labels with the corresponding shot/frame roles as well as defining any reused Subjects.
Analyze the attached images and incorporate the relevant visible features in subject_definitions and detailed_description. Define reusable people, objects, scenes and actions as Subjects. A picture used only for appearance is cited inside the Subject definition, not declared as a standalone frame anchor. Multiple views of the same person in a character sheet define one Subject, not several people or a sequence of shots. Do not copy the sheet layout or turn its backdrop into a new target setting unless requested. When one subject combines references, state what each provides, for example: <Subject 1> gets its appearance from <Picture 1> and its performance from <Video 1>. Only use labels from this request's inventory; the example is not an extra asset.
Preserve each assigned reference role across all six sections. A static appearance image does not supply a movement sequence. A reference supplied directly to H3 is not observable here: explicitly refer to it for its assigned content without guessing that content. When it defines performance, express the action as the target Subject following the source performance, including its timing and sequence. Do not add competing gestures, expressions, start/end poses or events. Retain user-requested camera moves, cuts, framing, transitions, setting and style; do not replace them with defaults or add a new camera move merely to expand the description. User-requested changes remain explicit overrides.
Keep the official detail guidance, using supported image details and requested scene information. If the user already supplied a detailed scene or shot sequence, preserve its actions, camera directions, transitions, text, timing and ending instead of summarizing or redesigning them. Format that supplied content for H3 and add grounded image information where useful. Do not pad with invented content or replace the full prompt with a generic reference sentence. Preserve dialogue and visible text verbatim, using the official speaker/dialogue notation for explicitly supplied speech.
Audio is not heard here: define audio reuse/reference only when requested, and never infer the soundtrack from a video mention. If the user asks to use an Audio asset exactly as it is, include audio reuse in summary and fully_copy in retention_analysis. State in overall_soundscape that this asset is the unchanged complete final soundtrack, without added, replaced or synthesized sound. Do not replace exact audio reuse with a descriptive soundscape or claim to have heard it. User-supplied visual sound cues remain synchronized to the unchanged audio. Use N/A for additional non_diegetic_music unless separately requested. Return only the complete prompt.`;
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
  if (!Number.isFinite(duration) || duration < 1 || duration > 20) {
    throw new AssemblyError("INVALID_DURATION", "Duration must be between 1 and 20 seconds.");
  }

  const declaredReferences = manifest.assets.filter(
    (a) => a.type === "audio" || a.analysis_requested !== false,
  );
  let referenceRoles = [];
  if (mode === 'Reference') {
    try { referenceRoles = motionReferenceRoles(brief, declaredReferences); }
    catch (error) { throw new AssemblyError('MOTION_REFERENCE_REQUIRED', error.message); }
  }
  const tags = mode === 'Reference' ? h3References(brief, declaredReferences, referenceRoles) : [];
  const externalVisual = tags.some(tag => /^<(?:Picture|Video) \d+>$/.test(tag));
  if (!manifest.valid && !(mode === 'Reference' && externalVisual && manifest.violations?.every(v => v.code === 'REFERENCE_REQUIRES_VISUAL'))) {
    throw new AssemblyError('INVALID_MEDIA_MANIFEST', 'The media manifest is not valid.', manifest.violations);
  }
  const eligible = declaredReferences.filter((a) => a.type !== "audio");
  const mediaInputs = eligible.map((asset) => ({
    asset_id: asset.id,
    reference: asset.reference,
    type: asset.type,
    requires_capability: CAPABILITY_BY_TYPE[asset.type],
    frames: (asset.frames || []).map((frame) => ({ timestamp: frame.timestamp, content_url: frame.url })),
    content_url: asset.content_url,
  }));
  const references = referenceInventory(declaredReferences, tags);
  const motionContract = motionRoleInstructions(referenceRoles, duration);
  const userContent =
    `Mode: ${mode}\n` +
    `Duration: ${duration} seconds\n` +
    `Aspect ratio: ${aspectRatio}\n\n` +
    "Reference manifest (audio is not analyzed by the local model; derive its copy/reference role only from the user's words and do not invent its content):\n" +
    `${references}\n\n` +
    `Creative brief:\n${brief}\n\n` +
    (motionContract ? '' : _finalContract(mode, duration));

  const guide = guideForMode(mode);
  return {
    schema_version: 1,
    guide: _stripContent(guide),
    input: {
      mode,
      duration_seconds: duration,
      aspect_ratio: aspectRatio,
      creative_brief: brief,
      reference_roles: referenceRoles,
      reference_tags: tags,
      media_manifest: manifest,
    },
    media_inputs: mediaInputs,
    supporting_guides: mode === "Reference" ? [_stripContent(loadGuide("base"))] : [],
    system_prompt: { custom: systemPromptCustom, content: systemPrompt },
    // Motion transfer has one dedicated contract, not the overlapping generic
    // wrapper and final contract that narrowed pictures to appearance alone.
    messages: [..._guideMessages(mode, motionContract && !systemPromptCustom ? null : systemPrompt), ...(motionContract ? [{ role: 'system', name: 'motion_transfer_contract', content: motionContract }] : []), { role: "user", content: userContent }],
  };
}

export function assembleRefinement(body, { manifest }) {
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

  // Reuse the real brief, reference inventory and image attachments. A previous
  // model draft is editable output, never an observation of the source media.
  const brief = typeof body.creative_brief === 'string' && body.creative_brief.trim()
    ? body.creative_brief : `Revise the supplied prompt while preserving its reference assignments: ${[...referenceTags(currentPrompt)].join(', ')}.`;
  const assembled = assembleRequest({ ...body, creative_brief: brief }, { manifest });
  const tags = mode === 'Reference' ? h3References(brief + '\n' + instruction, manifest.assets, assembled.input.reference_roles) : [];
  const references = referenceInventory(manifest.assets, tags);
  const userContent =
    "Rewrite the current H3 prompt according to the revision instruction. " +
    "The revision instruction takes precedence over the original brief. Preserve everything not affected by the revision. The current prompt is a model draft, not verified source evidence; correct any part that contradicts the original brief or reference roles. Return only the complete revised H3 prompt.\n\n" +
    `Mode: ${mode}\nDuration: ${body.duration_seconds} seconds\nAspect ratio: ${body.aspect_ratio}\n\n` +
    `Original brief:\n${brief}\n\nReference manifest:\n${references}\n\n` +
    `Current prompt:\n${currentPrompt}\n\n` +
    `Revision instruction:\n${instruction}\n\n` +
    (assembled.input.reference_roles.length ? '' : _finalContract(mode, body.duration_seconds));

  return {
    ...assembled,
    input: {
      ...assembled.input,
      current_prompt: currentPrompt,
      instruction,
      reference_tags: tags,
    },
    system_prompt: { custom: systemPromptCustom, content: systemPrompt },
    messages: [...assembled.messages.filter(m => m.role === 'system'), { role: "user", content: userContent }],
  };
}

function _stripContent(guide) {
  const { content, ...rest } = guide;
  return rest;
}
