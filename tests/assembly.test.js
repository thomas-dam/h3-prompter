import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRequest, assembleRefinement, AssemblyError } from "../src/lib/assembly.js";
import { STORE } from "../src/lib/media.js";
import { motionBrief } from './fixtures/motion-reference.js';

function validManifest() {
  return { valid: true, assets: [], violations: [], counts: { image: 0, video: 0, audio: 0 } };
}

test("assembles a T2VA request with valid fields", () => {
  const assembled = assembleRequest(
    { mode: "T2VA", creative_brief: "A baker opens shutters.", aspect_ratio: "16:9", duration_seconds: 6, session_id: "s1" },
    { manifest: validManifest() },
  );
  assert.equal(assembled.messages.length, 3);
  assert.equal(assembled.messages[0].role, "system");
  assert.equal(assembled.messages[2].role, "user");
  assert.match(assembled.messages[2].content, /Mode: T2VA/);
  assert.match(assembled.messages[2].content, /A baker opens shutters/);
  assert.equal(assembled.media_inputs.length, 0);
  assert.equal(assembled.supporting_guides.length, 0);
});

test("assembles a Reference request with supporting base guide", () => {
  const assembled = assembleRequest(
    { mode: "Reference", creative_brief: "Use Video 1 for motion.", aspect_ratio: "16:9", duration_seconds: 8, session_id: "s1" },
    { manifest: { ...validManifest(), assets: [{ id: 'v1', type: 'video', reference: '<Video 1>', filename: 'motion.mp4' }] } },
  );
  assert.equal(assembled.supporting_guides.length, 1);
  assert.equal(assembled.supporting_guides[0].id, "base");
  const userMsg = assembled.messages.at(-1);
  assert.match(userMsg.content, /Selected mode instructions/);
});

test("rejects invalid mode", () => {
  assert.throws(
    () => assembleRequest({ mode: "BAD", creative_brief: "x", aspect_ratio: "16:9", duration_seconds: 6 }, { manifest: validManifest() }),
    (err) => err instanceof AssemblyError && err.code === "INVALID_MODE",
  );
});

test('Ref2VA supports video references supplied to H3 without local uploads or invented observations', () => {
  const picture = { id: 'p1', type: 'image', reference: '<Picture 1>', filename: 'character.png' };
  const video = { id: 'v1', type: 'video', reference: '<Video 1>', filename: 'motion.mp4' };
  const body = { mode: 'Reference', creative_brief: motionBrief, aspect_ratio: '16:9', duration_seconds: 6 };
  const assemble = assets => assembleRequest(body, { manifest: { ...validManifest(), assets } });
  const result = assemble([picture, video]);
  assert.deepEqual(result.input.reference_roles, [{ reference: '<Video 1>', role: 'motion' }]);
  assert.deepEqual(result.media_inputs.map(i => [i.type, i.reference]), [['image', '<Picture 1>'], ['video', '<Video 1>']]);
  assert.match(result.messages.at(-1).content, /motion source is <Video 1>/);
  assert.match(result.messages.at(-1).content, /Do not specify individual movements/);
  assert.deepEqual(assemble([picture]).input.reference_tags, ['<Picture 1>', '<Video 1>']);
  const external = assembleRequest(body, { manifest: { ...validManifest(), valid: false, violations: [{ code: 'REFERENCE_REQUIRES_VISUAL' }] } });
  assert.deepEqual(external.media_inputs, []);
  assert.deepEqual(external.input.reference_tags, ['<Picture 1>', '<Video 1>']);
  assert.match(external.messages.at(-1).content, /<Video 1>: supplied directly to H3, not inspected/);
  assert.match(external.messages.find(m => m.name === 'motion_transfer_contract').content, /full official Ref2VA structure/);
  assert.doesNotMatch(external.messages.map(m => m.content).join('\n'), /word guidance does not apply|purposeful camera movement within that shot is allowed/);
  const second = { ...video, id: 'v2', reference: '<Video 2>' };
  assert.throws(() => assemble([picture, video, second]), /Name the motion source/);
  body.creative_brief = 'Make the girl in <Picture 1> act like the girl in <Video 2>.';
  assert.equal(assemble([picture, video, second]).input.reference_roles[0].reference, '<Video 2>');
  assert.equal(assemble([]).input.reference_roles[0].reference, '<Video 2>');
  const refinement = assembleRefinement({ mode: 'Reference', current_prompt: 'Use <Picture 1> with the motion of <Video 1>.', instruction: 'Make it concise.', duration_seconds: 6, aspect_ratio: '16:9' }, { manifest: validManifest() });
  assert.deepEqual(refinement.input.reference_tags, ['<Picture 1>', '<Video 1>']);
  const badDraft = assembleRefinement({ ...body, creative_brief: motionBrief, current_prompt: 'Invented footage from <Video 9>.', instruction: 'Correct the reference roles.' }, { manifest: validManifest() });
  assert.deepEqual(badDraft.input.reference_tags, ['<Picture 1>', '<Video 1>']);
});

test("rejects brief over 2000 chars", () => {
  assert.throws(
    () => assembleRequest({ mode: "T2VA", creative_brief: "x".repeat(2001), aspect_ratio: "16:9", duration_seconds: 6 }, { manifest: validManifest() }),
    (err) => err instanceof AssemblyError && err.code === "BRIEF_TOO_LONG",
  );
});

test("rejects invalid aspect ratio", () => {
  assert.throws(
    () => assembleRequest({ mode: "T2VA", creative_brief: "x", aspect_ratio: "5:4", duration_seconds: 6 }, { manifest: validManifest() }),
    (err) => err instanceof AssemblyError && err.code === "INVALID_ASPECT_RATIO",
  );
});

test("rejects duration out of range", () => {
  assert.throws(
    () => assembleRequest({ mode: "T2VA", creative_brief: "x", aspect_ratio: "16:9", duration_seconds: 25 }, { manifest: validManifest() }),
    (err) => err instanceof AssemblyError && err.code === "INVALID_DURATION",
  );
});

test("rejects invalid media manifest", () => {
  const invalidManifest = { valid: false, assets: [], violations: [{ code: "X", message: "bad" }], counts: {} };
  assert.throws(
    () => assembleRequest({ mode: "T2VA", creative_brief: "x", aspect_ratio: "16:9", duration_seconds: 6 }, { manifest: invalidManifest }),
    (err) => err instanceof AssemblyError && err.code === "INVALID_MEDIA_MANIFEST",
  );
});

test("refinement uses the original brief and real images, not a cached model script as observation", () => {
  const assembled = assembleRefinement(
    { mode: "I2VA", creative_brief: 'The girl waves once.', current_prompt: "old prompt", instruction: "make it brighter", session_id: "s1", duration_seconds: 8, aspect_ratio: '16:9' },
    { manifest: { ...validManifest(), assets: [{ id: 'p1', type: 'image', reference: '<Picture 1>', filename: 'character.png' }] } },
    "An unrelated old movie script.",
  );
  assert.match(assembled.messages[2].content, /Rewrite the current H3 prompt/);
  assert.match(assembled.messages[2].content, /The girl waves once/);
  assert.doesNotMatch(assembled.messages[2].content, /cached observation|unrelated old movie script/i);
  assert.deepEqual(assembled.media_inputs.map(m => m.asset_id), ['p1']);
});

test('base modes retain their distinct first/last frame alignment and image inputs', () => {
  const picture = { id: 'p1', type: 'image', reference: '<Picture 1>', filename: 'first.png' };
  for (const mode of ['T2VA', 'I2VA', 'FL2VA', 'L2VA']) {
    const assets = mode === 'T2VA' ? [] : mode === 'FL2VA' ? [picture, { ...picture, id: 'p2', reference: '<Picture 2>' }] : [picture];
    const result = assembleRequest({ mode, creative_brief: 'Move across the frame.', aspect_ratio: '16:9', duration_seconds: 8 }, { manifest: { ...validManifest(), assets } });
    const text = result.messages.at(-1).content;
    assert.match(text, /integrated_multimodal_description/);
    assert.equal(result.media_inputs.length, assets.length);
    if (mode === 'I2VA') assert.match(text, /Picture 1 is the actual first frame/);
    if (mode === 'FL2VA') assert.match(text, /Picture 2 is the final frame/);
    if (mode === 'L2VA') assert.match(text, /Picture 1 is the final frame, not the opening/);
    if (mode === 'FL2VA' || mode === 'L2VA') assert.match(text, /8\.00-second mark/);
  }
});

test('image reference shots and exact audio do not inherit a video-motion restriction', () => {
  const result = assembleRequest({ mode: 'Reference', creative_brief: 'Use <Picture 2> and <Picture 1> as reference frames and <Audio 1> exactly as it is. CUT 1: top-down view of a boy superhero. The camera slowly descends. TRANSITION: a WHIP PAN. CUT 2: low hero angle on a mech-kaiju. Hold on the roar.', aspect_ratio: '16:9', duration_seconds: 8 }, { manifest: validManifest() });
  assert.deepEqual(result.input.reference_roles, []);
  assert.deepEqual(result.input.reference_tags, ['<Picture 2>', '<Picture 1>', '<Audio 1>']);
  assert.ok(!result.messages.some(m => m.name === 'motion_transfer_contract'));
  assert.match(result.messages.at(-1).content, /WHIP PAN/);
  assert.doesNotMatch(result.messages.at(-1).content, /not keyframe completion|Prefer one continuous shot/);
});

test("rejects refinement with oversized current prompt", () => {
  assert.throws(
    () => assembleRefinement({ mode: "T2VA", current_prompt: "x".repeat(20001), instruction: "fix", session_id: "s1" }, { manifest: validManifest() }),
    (err) => err instanceof AssemblyError && err.code === "PROMPT_TOO_LONG",
  );
});
