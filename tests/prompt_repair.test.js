import { test } from "node:test";
import assert from "node:assert/strict";
import {
  referenceTags,
  unexpectedAudioTask,
  explicitConstraintViolations,
  auditFailures,
  narrowRepairMessages,
} from "../src/lib/prompt_repair.js";

test("reference tags are normalized", () => {
  assert.deepEqual(
    referenceTags("Use <picture 1>, <Video 2>, and <AUDIO 3>."),
    new Set(["<Picture 1>", "<Video 2>", "<Audio 3>"]),
  );
});

test("audio task without audio asset is hard error", () => {
  const expected = new Set(["<Picture 1>", "<Video 1>"]);
  assert.equal(unexpectedAudioTask("reference generation + audio reference", expected), true);
  assert.equal(unexpectedAudioTask("reference generation", expected), false);
  assert.equal(unexpectedAudioTask("reference generation + audio reference", new Set([...expected, "<Audio 1>"])), false);
});

test("motion-only provenance check is narrow", () => {
  const brief = "Use Video 1 only as the motion reference.";
  const bad = "<Subject 2> is the studio environment from <Video 1>.";
  const good = "A new target street frames the choreography from <Video 1>.";
  assert.ok(explicitConstraintViolations(brief, bad).length > 0);
  assert.deepEqual(explicitConstraintViolations(brief, good), []);
});

test("explicit no-cuts is enforced but unspecified camera is not", () => {
  const prompt = "[Shot 1] A tracking shot. [Shot 2] Cut to a close-up.";
  assert.ok(explicitConstraintViolations("Use one continuous shot with no cuts.", prompt).length > 0);
  assert.deepEqual(explicitConstraintViolations("Make it cinematic.", prompt), []);
});

test("narrow repair receives original request and exact violations", () => {
  const assembled = {
    messages: [
      { role: "system", content: "guide" },
      { role: "user", content: "Creative brief:\nUse Video 1 only for motion. Add some music." },
    ],
  };
  const messages = narrowRepairMessages(
    assembled,
    "[reference generation + audio reference] draft with <Audio 1>",
    ["unexpected reference tags: <Audio 1>"],
    new Set(["<Picture 1>", "<Video 1>"]),
    10,
  );
  assert.match(messages[0].content, /not a new prompt-generation pass/);
  assert.match(messages[0].content, /unexpected reference tags: <Audio 1>/);
  assert.match(messages[1].content, /Use Video 1 only for motion/);
});

test("failure summary contains only objective checks", () => {
  const failures = auditFailures({
    missing_task_label: true,
    unexpected_reference_tags: ["<Audio 1>"],
    unexpected_audio_task: true,
  });
  assert.ok(failures.includes("missing summary task label"));
  assert.ok(failures.includes("unexpected reference tags: <Audio 1>"));
  assert.ok(!failures.some((f) => f.includes("word")));
});