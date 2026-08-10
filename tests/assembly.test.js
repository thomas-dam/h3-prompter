import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRequest, assembleRefinement, AssemblyError } from "../src/lib/assembly.js";
import { STORE } from "../src/lib/media.js";

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
    { manifest: validManifest() },
  );
  assert.equal(assembled.supporting_guides.length, 1);
  assert.equal(assembled.supporting_guides[0].id, "base");
  const userMsg = assembled.messages.at(-1);
  assert.match(userMsg.content, /Final request classification/);
});

test("rejects invalid mode", () => {
  assert.throws(
    () => assembleRequest({ mode: "BAD", creative_brief: "x", aspect_ratio: "16:9", duration_seconds: 6 }, { manifest: validManifest() }),
    (err) => err instanceof AssemblyError && err.code === "INVALID_MODE",
  );
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

test("assembles refinement request", () => {
  const assembled = assembleRefinement(
    { mode: "T2VA", current_prompt: "old prompt", instruction: "make it brighter", session_id: "s1" },
    { manifest: validManifest() },
    "cached observation",
  );
  assert.match(assembled.messages[2].content, /Rewrite the current H3 prompt/);
  assert.match(assembled.messages[2].content, /cached observation/);
  assert.equal(assembled.media_inputs.length, 0);
});

test("rejects refinement with oversized current prompt", () => {
  assert.throws(
    () => assembleRefinement({ mode: "T2VA", current_prompt: "x".repeat(20001), instruction: "fix", session_id: "s1" }, { manifest: validManifest() }),
    (err) => err instanceof AssemblyError && err.code === "PROMPT_TOO_LONG",
  );
});