import { test } from "node:test";
import assert from "node:assert/strict";
import { auditPrompt } from "../src/lib/prompt_audit.js";

test("cut timing audit checks order, numbering and the untimed first shot", () => {
  const append = (text) => referencePrompt(340).replace("overall_soundscape:", `${text}\n\noverall_soundscape:`);
  const good = append("[Shot 2] At 00:02.000, the camera cuts to another view.\n[Shot 3] At 00:03.000, a hard cut reveals the room.");
  assert.deepEqual(auditPrompt(good, "Reference", 4).shot_timing_violations, []);
  for (const bad of [good.replace("00:03.000", "00:01.000"), good.replace("[Shot 3]", "[Shot 2]"), good.replace("00:03.000", "00:04.000"), good.replace("[Shot 1]", "[Shot 1] At 00:00.000,")]) {
    assert.equal(auditPrompt(bad, "Reference", 4).repair_required, true);
  }
});

function referencePrompt(wordCount, { includeSoundscape = true } = {}) {
  const detailed = "visible ".repeat(wordCount).trim();
  const soundscape = includeSoundscape ? "overall_soundscape:\nN/A\n\n" : "";
  return (
    "subject_definitions:\n<Subject 1> comes from <Picture 1>.\n\n" +
    "summary:\n[reference generation] A restrained shot.\n\n" +
    "retention_analysis:\n<Subject 1>: fully_preserved.\n\n" +
    `detailed_description:\n[Shot 1] ${detailed}\n\n` +
    soundscape +
    "non_diegetic_music:\nN/A"
  );
}

test("340 words is accepted without repair", () => {
  const result = auditPrompt(referencePrompt(340));
  assert.equal(result.official_format_pass, true);
  assert.equal(result.generation_word_target_met, false);
  assert.equal(result.detailed_description_length_status, "acceptable_below_target");
  assert.equal(result.repair_required, false);
});

test("250-299 words is internal warning only", () => {
  const result = auditPrompt(referencePrompt(270));
  assert.equal(result.detailed_description_length_status, "short_internal_warning");
  assert.equal(result.repair_required, false);
});

test("under 250 words is a quality warning, not a repair", () => {
  const result = auditPrompt(referencePrompt(249));
  assert.equal(result.detailed_description_length_status, "severely_short_internal_warning");
  assert.ok(result.quality_warnings.includes("severely short detailed_description"));
  assert.equal(result.repair_required, false);
});

test("missing section requires repair regardless of length", () => {
  const result = auditPrompt(referencePrompt(360, { includeSoundscape: false }));
  assert.ok(result.missing_sections.includes("overall_soundscape"));
  assert.equal(result.structure_pass, false);
  assert.equal(result.repair_required, true);
});

test("malformed timestamp requires repair", () => {
  const prompt = referencePrompt(340).replace("A restrained shot.", "At 00:153, a restrained shot.");
  const result = auditPrompt(prompt, "Reference", 10);
  assert.deepEqual(result.invalid_timestamps, ["00:153"]);
  assert.equal(result.repair_required, true);
});

test("timestamp beyond duration requires repair", () => {
  const prompt = referencePrompt(340).replace("A restrained shot.", "At 00:12.000, a restrained shot.");
  const result = auditPrompt(prompt, "Reference", 10);
  assert.deepEqual(result.invalid_timestamps, ["00:12.000"]);
  assert.equal(result.repair_required, true);
});

test("valid timestamp is accepted", () => {
  const prompt = referencePrompt(340).replace("A restrained shot.", "At 00:03.500, a restrained shot.");
  const result = auditPrompt(prompt, "Reference", 10);
  assert.deepEqual(result.invalid_timestamps, []);
  assert.equal(result.repair_required, false);
});

test("unrequested camera direction is not a hard error", () => {
  const prompt = referencePrompt(340).replace("A restrained shot.", "The shot cuts to a close-up and slowly zooms in.");
  const result = auditPrompt(prompt, "Reference", null, false);
  assert.deepEqual(result.unsupported_camera_directions, ["cuts to", "zooms in"]);
  assert.equal(result.repair_required, false);
});

test("requested camera direction is accepted", () => {
  const prompt = referencePrompt(340).replace("A restrained shot.", "The shot cuts to a close-up and slowly zooms in.");
  const result = auditPrompt(prompt, "Reference", null, true);
  assert.deepEqual(result.unsupported_camera_directions, []);
  assert.equal(result.repair_required, false);
});

test("internal video sheet language requires repair", () => {
  const prompt = referencePrompt(340).replace("A restrained shot.", "Follow the sampled frames and the gesture at the 5.507s mark.");
  const result = auditPrompt(prompt);
  assert.deepEqual(result.internal_video_representation_terms, ["sampled frames", "5.507s mark"]);
  assert.equal(result.repair_required, true);
});

test("dialogue without speaker ID requires repair", () => {
  const prompt = referencePrompt(340).replace("A restrained shot.", "She says <d>Hello.</d>");
  const result = auditPrompt(prompt);
  assert.equal(result.missing_dialogue_source, true);
  assert.equal(result.repair_required, true);
});

test("dialogue with speaker ID is accepted", () => {
  const prompt = referencePrompt(340).replace("A restrained shot.", "(S1) says <d>Hello.</d>");
  const result = auditPrompt(prompt);
  assert.equal(result.missing_dialogue_source, false);
  assert.equal(result.repair_required, false);
});

test("missing task label requires repair", () => {
  const result = auditPrompt(referencePrompt(340).replace("[reference generation] ", ""));
  assert.equal(result.missing_task_label, true);
  assert.equal(result.repair_required, true);
});

test("missing shot marker requires repair", () => {
  const result = auditPrompt(referencePrompt(340).replace("[Shot 1] ", ""));
  assert.equal(result.missing_shot_marker, true);
  assert.equal(result.repair_required, true);
});
