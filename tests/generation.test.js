import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../src/lib/generation.js";

const assembled = {
  input: {
    mode: "T2VA",
    duration_seconds: 6,
    creative_brief: "A cup sits on a table.",
    media_manifest: { session_id: "00000000-0000-4000-8000-000000000003" },
  },
  media_inputs: [],
  messages: [
    { role: "system", content: "Write an H3 prompt." },
    { role: "user", content: "Write a prompt about a cup." },
  ],
};

test("retries an empty final response with Thinking off", async () => {
  const calls = [];
  const responses = [
    { choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    { choices: [{ message: { content: "A ceramic cup sits in warm morning light." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 12 } },
  ];
  const result = await generate({
    assembled,
    provider: "lmstudio",
    modelId: "test-model",
    settings: {},
    runtimePlan: { max_output_tokens: 1536 },
    thinking: false,
    sessionStore: { get() { throw new Error("No media should be requested."); } },
    chatCompletion: async ({ payload }) => {
      calls.push(payload);
      return responses.shift();
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].chat_template_kwargs.enable_thinking, false);
  assert.equal(result.thinking_fallback, true);
  assert.equal(result.prompt, "A ceramic cup sits in warm morning light.");
});
