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