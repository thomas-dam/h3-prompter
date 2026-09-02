const CAMERA_MOVEMENT = /\b(?:zoom(?:s|ed|ing)?|pan(?:s|ned|ning)?|doll(?:y|ies|ied|ying)|tracking shot|camera\s+(?:moves?|pulls?|pushes?|pans?|zooms?|tracks?|dollies?))\b/i;

export function referenceTags(text) {
  const tags = new Set();
  for (const m of text.matchAll(/<\s*(Picture|Video|Audio)\s+(\d+)\s*>/gi)) {
    tags.add(`<${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}>`);
  }
  return tags;
}

export function dialogueLines(text) {
  const matches = text.matchAll(/<d>.*?<\/d>/gis);
  return [...matches].map((m) => m[0].trim());
}

export function unexpectedAudioTask(taskLabel, expectedTags) {
  if ([...expectedTags].some((tag) => tag.startsWith("<Audio "))) return false;
  return !!(taskLabel && /\baudio\s+(?:reuse|reference)\b/i.test(taskLabel));
}

export function explicitConstraintViolations(creativeBrief, prompt) {
  const violations = [];
  if (/\b(?:no cuts?|without cuts?|single continuous shot|one continuous shot)\b/i.test(creativeBrief)) {
    if (/\[Shot\s+[2-9]\d*\]|\bcut(?:s)?\s+to\b/i.test(prompt)) {
      violations.push("the user explicitly requested one continuous shot without cuts");
    }
  }
  if (/\b(?:static|locked(?:-off)?|fixed)\s+camera\b|\bno camera movement\b/i.test(creativeBrief)) {
    if (CAMERA_MOVEMENT.test(prompt)) {
      violations.push("the user explicitly requested a static camera");
    }
  }
  const motionOnlyVideos = new Set();
  for (const clause of creativeBrief.split(/[.\n;]+/)) {
    if (/\b(?:only|solely)\b/i.test(clause) && /\b(?:motion|movement|dance|choreograph\w*)\b/i.test(clause)) {
      for (const m of clause.matchAll(/\bVideo\s+([1-3])\b/gi)) motionOnlyVideos.add(m[1]);
    }
  }
  const excludedTrait = "(?:environment|background|setting|location|lighting|performer|identity|clothing|wardrobe|outfit|audio|soundtrack)";
  for (const number of [...motionOnlyVideos].sort((a, b) => Number(a) - Number(b))) {
    const tag = `<\\s*Video\\s+${number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`;
    const provenance = new RegExp(
      `\\b${excludedTrait}\\b[^.\\n]{0,90}\\b(?:from|of|in)\\s*${tag}|${tag}[^.\\n]{0,90}\\b(?:provides?|defines?|supplies?|is used for)\\s+(?:the\\s+)?${excludedTrait}\\b`,
      "i",
    );
    if (provenance.test(prompt)) {
      violations.push(`<Video ${number}> is assigned only to motion but supplies an excluded source trait`);
    }
  }
  return violations;
}

export function auditFailures(audit) {
  const failures = [];
  if (audit.missing_sections?.length) failures.push("missing required sections");
  if (audit.section_order_valid === false) failures.push("incorrect section order");
  if (audit.missing_task_label) failures.push("missing summary task label");
  if (audit.missing_shot_marker) failures.push("missing [Shot 1] marker");
  if (audit.invalid_timestamps?.length) failures.push("invalid target timestamps");
  failures.push(...(audit.shot_timing_violations || []));
  if (audit.internal_video_representation_terms?.length) failures.push("internal contact-sheet language");
  if (audit.missing_dialogue_source) failures.push("dialogue without a stable speaker ID");
  if (audit.missing_reference_tags?.length) failures.push("missing reference tags: " + audit.missing_reference_tags.join(", "));
  if (audit.unexpected_reference_tags?.length) failures.push("unexpected reference tags: " + audit.unexpected_reference_tags.join(", "));
  if (audit.unexpected_audio_task) failures.push("audio reference/reuse declared without an uploaded audio asset");
  failures.push(...(audit.explicit_constraint_violations || []));
  return failures;
}

export function narrowRepairMessages(assembled, draft, violations, expectedTags, durationSeconds) {
  const originalRequest = assembled.messages.find((m) => m.role === "user").content;
  const allowedTags = [...expectedTags].sort().join(", ") || "none";
  return [
    {
      role: "system",
      content:
        "This is a narrow correction pass, not a new prompt-generation pass. Correct only the exact violations " +
        "listed below and preserve every other supported fact, reference role, action, dialogue line, shot, and " +
        "creative choice unchanged. Return the complete corrected prompt with no commentary. The exact allowed " +
        `numbered media tags are: ${allowedTags}. Do not add any other media tag. Requested music without an ` +
        "uploaded audio asset belongs only in non_diegetic_music and is not audio reference or reuse. Target " +
        `timestamps must use MM:SS.mmm and remain within ${durationSeconds} seconds. Violations: ` +
        violations.join("; "),
    },
    {
      role: "user",
      content: `ORIGINAL REQUEST:\n${originalRequest}\n\nDRAFT TO CORRECT:\n${draft}`,
    },
  ];
}
