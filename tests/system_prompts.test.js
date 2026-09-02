import { test } from "node:test";
import assert from "node:assert/strict";
import {
  systemPromptForMode,
  resolveSystemPrompt,
  SYSTEM_WRAPPER,
  REFERENCE_SYSTEM_WRAPPER,
  MAX_SYSTEM_PROMPT_CHARS,
  SystemPromptError,
} from "../src/lib/system_prompts.js";
import { REF2VA_SYSTEM_PROMPT, loadRef2VASystemPrompt } from "../src/lib/ref2va_system_prompt.js";
import { recoverRef2VARequest } from "../src/lib/ref2va_original.js";

test("standard modes share one default system prompt", () => {
  assert.equal(systemPromptForMode("T2VA"), SYSTEM_WRAPPER);
  assert.equal(systemPromptForMode("FL2VA"), SYSTEM_WRAPPER);
});

test("Reference has its own default", () => {
  assert.equal(systemPromptForMode("Reference"), REFERENCE_SYSTEM_WRAPPER);
  assert.notEqual(REFERENCE_SYSTEM_WRAPPER, SYSTEM_WRAPPER);
  assert.match(REFERENCE_SYSTEM_WRAPPER, /transfer only that role/);
  assert.match(REFERENCE_SYSTEM_WRAPPER, /must not contribute its performer identity/);
  assert.match(REFERENCE_SYSTEM_WRAPPER, /never invent or pad details solely/);
  assert.match(REFERENCE_SYSTEM_WRAPPER, /preserve user-supplied dialogue, lyrics, and visible text verbatim/);
  assert.doesNotMatch(REFERENCE_SYSTEM_WRAPPER, /spins/);
  assert.doesNotMatch(REFERENCE_SYSTEM_WRAPPER, /kisses/);
  assert.match(REFERENCE_SYSTEM_WRAPPER, /unsupported subject actions, expressions, events, transitions/);
});

test("custom prompt fully replaces default", () => {
  const { prompt, custom } = resolveSystemPrompt("Reference", "  Custom instruction.  ");
  assert.equal(prompt, "Custom instruction.");
  assert.equal(custom, true);
});

test("oversized custom prompt is rejected", () => {
  assert.throws(
    () => resolveSystemPrompt("T2VA", "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1)),
    (err) => err instanceof SystemPromptError && err.code === "SYSTEM_PROMPT_TOO_LONG",
  );
});
test("Ref2VA requests use the prompt documented in the markdown file", () => {
  assert.match(REF2VA_SYSTEM_PROMPT, /^You are an expert prompt engineer and cinematic director for MiniMax H3 Ref2VA/);
  assert.match(REF2VA_SYSTEM_PROMPT, /MOVEMENT AND SPATIAL PATHING/);
  assert.match(REF2VA_SYSTEM_PROMPT, /CREATIVE ENHANCEMENT/);
  assert.match(REF2VA_SYSTEM_PROMPT, /never ask a clarifying question/);
  assert.doesNotMatch(REF2VA_SYSTEM_PROMPT, /^```/m);
  assert.equal(REF2VA_SYSTEM_PROMPT, loadRef2VASystemPrompt());
});

test("a Ref2VA request sends that system prompt", () => {
  const assembled = { input: { creative_brief: "A baker at dawn." }, media_inputs: [] };
  const body = { mode: "Reference", duration_seconds: 10, description: "A baker at dawn." };
  const request = recoverRef2VARequest(assembled, body);
  assert.equal(request.system_prompt.content, REF2VA_SYSTEM_PROMPT);
  assert.equal(request.system_prompt.custom, false);
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[0].content, REF2VA_SYSTEM_PROMPT);
});

test("a custom override still replaces the Ref2VA prompt", () => {
  const assembled = { input: { creative_brief: "A baker at dawn." }, media_inputs: [] };
  const body = { mode: "Reference", duration_seconds: 10, system_prompt_override: "My own rules." };
  const request = recoverRef2VARequest(assembled, body);
  assert.equal(request.system_prompt.content, "My own rules.");
  assert.equal(request.system_prompt.custom, true);
});
