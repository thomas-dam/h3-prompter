import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../src/lib/generation.js";
import { assembleRequest, assembleRefinement } from '../src/lib/assembly.js';
import { motionBrief, motionPrompt, inventedMotionPrompt } from './fixtures/motion-reference.js';

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

test("provider transport handles JSON repairs, split SSE and provider errors", async () => {
  const { streamChatCompletion } = await import('../src/providers/llm.js');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({choices:[{message:{content:'Repaired prompt'},finish_reason:'stop'}]}), {headers:{'Content-Type':'application/json'}});
    assert.equal((await streamChatCompletion({url:'http://unused',payload:{stream:false}})).choices[0].message.content,'Repaired prompt');
    const sse='data: {"choices":[{"delta":{"content":"✦ prompt"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}';
    globalThis.fetch=async()=>new Response(new ReadableStream({start(c){for(const byte of new TextEncoder().encode(sse))c.enqueue(new Uint8Array([byte]));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
    assert.equal((await streamChatCompletion({url:'http://unused',payload:{}})).choices[0].message.content,'✦ prompt');
    globalThis.fetch=async()=>new Response('Unauthorized',{status:401});
    await assert.rejects(streamChatCompletion({url:'http://unused',payload:{}}),/AUTH_FAILURE/);
    globalThis.fetch=async()=>new Response('data: {"error":{"message":"vision unsupported"}}\n');
    await assert.rejects(streamChatCompletion({url:'http://unused',payload:{}}),/vision unsupported/);
  } finally { globalThis.fetch=original; }
});

test('Ref2VA repairs a dropped motion source and never returns an unrepaired invented draft as success', async () => {
  const request = assembleRequest({ mode: 'Reference', creative_brief: motionBrief, duration_seconds: 6, aspect_ratio: '16:9' }, {
    manifest: { valid: true, assets: [
      { id: 'p1', type: 'image', reference: '<Picture 1>', filename: 'character_<Video 9>.png' },
      { id: 'v1', type: 'video', reference: '<Video 1>', filename: 'motion.mp4' },
    ] },
  });
  // Attachment rendering is covered by the browser test; this isolates correction policy.
  request.media_inputs = [];
  const args = { assembled: request, provider: 'lmstudio', modelId: 'test-model', settings: {}, runtimePlan: { max_output_tokens: 1536 }, thinking: false };
  const response = content => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  const calls = [];
  const repaired = await generate({ ...args, chatCompletion: async ({payload}) => { calls.push(payload); return response(calls.length === 1 ? inventedMotionPrompt : motionPrompt); } });
  assert.equal(repaired.prompt, motionPrompt);
  assert.equal(repaired.format_repair_applied, true);
  assert.deepEqual(repaired.prompt_audit.missing_reference_tags, []);
  assert.match(calls[1].messages[0].content, /missing reference tags: <Video 1>/);
  assert.match(calls[1].messages[0].content, /detailed_description must explicitly use <Video 1>/);
  assert.doesNotMatch(calls[1].messages[0].content, /Video 9/);
  for (const draft of [inventedMotionPrompt, motionPrompt.replace('of <Video 1> throughout the clip', 'of an imagined routine throughout the clip')]) {
    let attempts = 0;
    await assert.rejects(generate({ ...args, chatCompletion: async () => { attempts++; return response(draft); } }), error => error.code === 'REFERENCE_GROUNDING_FAILED' && /failed draft was not saved/.test(error.message));
    assert.equal(attempts, 2);
  }
  let attempts = 0;
  await assert.rejects(generate({ ...args, chatCompletion: async () => { if (++attempts === 2) throw new Error('repair offline'); return response(inventedMotionPrompt); } }), error => error.code === 'REFERENCE_GROUNDING_FAILED');
});

test('refinement does not repair an explicitly requested camera change back to an old restriction', async () => {
  const request = assembleRefinement({mode:'Reference',creative_brief:motionBrief+' Static camera.',current_prompt:motionPrompt,instruction:'Have the camera push forward slowly.',duration_seconds:6,aspect_ratio:'16:9'}, {manifest:{valid:true,assets:[],violations:[]}});
  const revised = motionPrompt.replace('[Shot 1]', '[Shot 1] The camera pushes forward slowly.');
  let calls = 0;
  const result = await generate({assembled:request,provider:'lmstudio',modelId:'test-model',settings:{},runtimePlan:{max_output_tokens:1536},thinking:false,chatCompletion:async()=>{calls++;return {choices:[{message:{content:revised},finish_reason:'stop'}]};}});
  assert.equal(result.prompt,revised);
  assert.equal(calls,1);
  assert.deepEqual(result.prompt_audit.explicit_constraint_violations,[]);
});
