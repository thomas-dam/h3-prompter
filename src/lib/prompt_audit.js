export const REFERENCE_SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
];

export const TIMESTAMP_CANDIDATE = /(?<!\d)\d{2}:\d{2,3}(?:\.\d{1,3})?(?!\d)/g;
export const VALID_TIMESTAMP = /^(\d{2}):(\d{2})\.(\d{3})$/;
export const CAMERA_DIRECTION = /\b(?:cut(?:s)?\s+to|zoom(?:s|ed|ing)?(?:-in|-out|\s+in|\s+out)?|pan(?:s|ned|ning)?(?:\s+(?:up|down|left|right|across))?|doll(?:y|ies|ied|ying)|tracking shot|camera\s+(?:moves?|pulls?|pushes?|pans?|zooms?|tracks?|dollies?))\b/gi;
export const INTERNAL_VIDEO_REPRESENTATION = /\b(?:contact sheet|sheet cell(?:s)?|sampled frame(?:s)?|sample frame(?:s)?|\d+(?:\.\d+)?s\s+mark)\b/gi;

export function invalidTimestamps(prompt, durationSeconds = null) {
  const invalid = [];
  const seen = new Set();
  for (const value of prompt.matchAll(TIMESTAMP_CANDIDATE)) {
    const v = value[0];
    const match = VALID_TIMESTAMP.exec(v);
    if (!match) {
      if (!seen.has(v)) { seen.add(v); invalid.push(v); }
      continue;
    }
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const milliseconds = parseInt(match[3], 10);
    const total = minutes * 60 + seconds + milliseconds / 1000;
    if (seconds >= 60 || (durationSeconds !== null && total > durationSeconds + 0.001)) {
      if (!seen.has(v)) { seen.add(v); invalid.push(v); }
    }
  }
  return invalid;
}

export function cameraStructureRequested(intentText) {
  return /\b(?:camera|framing|shot|cut|zoom|pan|dolly|tracking|handheld|pov|temporal structure|whole video|entire video)\b/i.test(intentText);
}

export function unsupportedCameraDirections(prompt, allowed) {
  if (allowed) return [];
  const seen = new Set();
  const out = [];
  for (const m of prompt.matchAll(CAMERA_DIRECTION)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  return out;
}

export function internalVideoRepresentationTerms(prompt) {
  const seen = new Set();
  const out = [];
  for (const m of prompt.matchAll(INTERNAL_VIDEO_REPRESENTATION)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  return out;
}

export function auditPrompt(prompt, mode = "Reference", durationSeconds = null, cameraStructureAllowed = true) {
  if (mode !== "Reference") {
    return {
      mode,
      official_format_pass: null,
      reference_understanding: "not_applicable",
    };
  }
  const positions = {};
  for (const section of REFERENCE_SECTIONS) {
    const re = new RegExp(`^\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "im");
    const m = re.exec(prompt);
    if (m) positions[section] = m;
  }

  const missing = REFERENCE_SECTIONS.filter((s) => !(s in positions));
  const ordered = Object.entries(positions).sort((a, b) => a[1].index - b[1].index);
  const sectionOrder = ordered.map(([name]) => name);
  const orderValid = sectionOrder.join("|") === REFERENCE_SECTIONS.filter((s) => s in positions).join("|");

  let detailed = "";
  const detailedMatch = positions["detailed_description"];
  if (detailedMatch) {
    const following = ordered.filter(([, m]) => m.index > detailedMatch.index).map(([, m]) => m.index);
    const end = following.length ? Math.min(...following) : prompt.length;
    detailed = prompt.slice(detailedMatch.index + detailedMatch[0].length, end);
  }
  const detailedForCount = detailed.replace(/\[Shot\s+\d+\]/gi, "");
  const detailedWords = (detailedForCount.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) || []).length;
  const hasShotMarker = /^\s*\[Shot\s+1\]/im.test(detailed);
  const shotTimingViolations = [];
  let priorCut = 0;
  let expectedShot = 1;
  for (const match of detailed.matchAll(/\[Shot\s+(\d+)\](?:\s+At\s+(\d{2}:\d{2}\.\d{3}))?/gi)) {
    const number = Number(match[1]);
    if (number !== expectedShot++) shotTimingViolations.push("Shot numbers must be sequential without duplicates.");
    if (number === 1 && match[2]) shotTimingViolations.push("Shot 1 must not start with a timestamp.");
    if (number > 1) {
      if (!match[2]) shotTimingViolations.push(`Shot ${number} needs an At MM:SS.mmm cut time.`);
      else {
        const [minutes, seconds] = match[2].split(":").map(Number);
        const time = minutes * 60 + seconds;
        if (time <= priorCut || (durationSeconds !== null && time >= durationSeconds)) shotTimingViolations.push("Cut times must increase and fall before the clip ends.");
        priorCut = time;
      }
    }
  }

  const summaryMatch = positions["summary"];
  let taskLabel = null;
  if (summaryMatch) {
    const after = prompt.slice(summaryMatch.index + summaryMatch[0].length);
    const labelMatch = /^\s*\[([^\]]+)\]/i.exec(after);
    if (labelMatch) taskLabel = labelMatch[1].trim();
  }
  const missingTaskLabel = summaryMatch !== undefined && taskLabel === null;
  const missingShotMarker = detailedMatch !== undefined && !hasShotMarker;
  const generationWordTarget = !!(taskLabel && /generation/i.test(taskLabel));
  let wordTargetMet = generationWordTarget ? (detailedWords >= 350 && detailedWords <= 500) : null;
  let lengthStatus;
  if (!generationWordTarget) {
    lengthStatus = "not_applicable";
  } else if (detailedWords < 250) {
    lengthStatus = "severely_short_internal_warning";
  } else if (detailedWords < 300) {
    lengthStatus = "short_internal_warning";
  } else if (detailedWords < 350) {
    lengthStatus = "acceptable_below_target";
  } else if (detailedWords <= 500) {
    lengthStatus = "official_target";
  } else {
    lengthStatus = "above_target";
  }
  const structurePass = missing.length === 0 && orderValid;
  const invalidTimestampValues = invalidTimestamps(prompt, durationSeconds);
  const unsupportedCameraValues = unsupportedCameraDirections(prompt, cameraStructureAllowed);
  const internalVideoTerms = internalVideoRepresentationTerms(prompt);
  const hasDialogue = /<d>.*?<\/d>/is.test(prompt);
  const dialogueSourceValid =
    /\(S\d+(?:\s*,\s*S\d+)*\)/.test(prompt) || /<Audio\s+\d+>/i.test(prompt);
  const missingDialogueSource = hasDialogue && !dialogueSourceValid;
  const qualityWarnings = [];
  if (lengthStatus === "severely_short_internal_warning") {
    qualityWarnings.push("severely short detailed_description");
  } else if (lengthStatus === "short_internal_warning") {
    qualityWarnings.push("short detailed_description");
  }
  const repairRequired =
    !structurePass ||
    invalidTimestampValues.length > 0 ||
    internalVideoTerms.length > 0 ||
    missingDialogueSource ||
    missingTaskLabel ||
    missingShotMarker ||
    shotTimingViolations.length > 0;

  return {
    mode,
    required_sections: [...REFERENCE_SECTIONS],
    missing_sections: missing,
    section_order_valid: orderValid,
    task_label: taskLabel,
    missing_task_label: missingTaskLabel,
    missing_shot_marker: missingShotMarker,
    shot_timing_violations: shotTimingViolations,
    detailed_description_words: detailedWords,
    generation_word_target_applies: generationWordTarget,
    generation_word_target_met: wordTargetMet,
    detailed_description_length_status: lengthStatus,
    structure_pass: structurePass,
    invalid_timestamps: invalidTimestampValues,
    unsupported_camera_directions: unsupportedCameraValues,
    quality_warnings: qualityWarnings,
    internal_video_representation_terms: internalVideoTerms,
    missing_dialogue_source: missingDialogueSource,
    repair_required: repairRequired,
    official_format_pass:
      structurePass &&
      invalidTimestampValues.length === 0 &&
      internalVideoTerms.length === 0 &&
      !missingDialogueSource &&
      !missingTaskLabel &&
      !missingShotMarker &&
      shotTimingViolations.length === 0,
    quality_target_pass: qualityWarnings.length === 0,
    reference_understanding: "manual_review_required",
  };
}
