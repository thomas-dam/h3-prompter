import { finalText, ModelError } from "../lib/contract.js";
import { auditPrompt, cameraStructureRequested } from "../lib/prompt_audit.js";
import {
  auditFailures,
  dialogueLines,
  explicitConstraintViolations,
  narrowRepairMessages,
  referenceTags,
  unexpectedAudioTask,
} from "../lib/prompt_repair.js";
import { buildChatMessages, streamChatCompletion } from "../providers/llm.js";
import { STANDARD_OUTPUT_TOKENS } from "../lib/context.js";

export function providerUrlAndHeaders(provider, settings, modelId) {
  if (provider === "lmstudio") {
    return {
      url: "http://127.0.0.1:1234/v1/chat/completions",
      headers: {},
      model: modelId,
    };
  }
  if (provider === "openrouter") {
    if (!settings.openrouter_key) throw new ModelError("AUTH_FAILURE", "OpenRouter API key is not set.");
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: { Authorization: `Bearer ${settings.openrouter_key}` },
      model: modelId,
    };
  }
  throw new ModelError("INVALID_PROVIDER", `Unknown provider: ${provider}`);
}

export async function generate({
  assembled,
  provider,
  modelId,
  settings,
  runtimePlan,
  thinking,
  seed,
  sessionStore,
  signal,
  onDelta,
  chatCompletion = streamChatCompletion,
}) {
  const { url, headers, model } = providerUrlAndHeaders(provider, settings, modelId);
  const { messages, metrics } = buildChatMessages(assembled, sessionStore);

  const payload = {
    model,
    messages,
    temperature: 1.0,
    top_p: 0.95,
    top_k: 64,
    max_tokens: runtimePlan.max_output_tokens,
    stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: thinking },
  };
  if (seed !== undefined && seed !== null) payload.seed = seed;

  let response;
  try {
    response = await chatCompletion({ url, headers, payload, signal, onDelta });
  } catch (error) {
    if (error.message.startsWith("GENERATION_CANCELLED")) throw error;
    if (error.message.startsWith("AUTH_FAILURE")) throw new ModelError("AUTH_FAILURE", error.message.slice("AUTH_FAILURE: ".length));
    if (error.message.startsWith("PROVIDER_UNAVAILABLE")) throw new ModelError("PROVIDER_UNAVAILABLE", error.message.slice("PROVIDER_UNAVAILABLE: ".length));
    if (provider === "lmstudio" && error instanceof TypeError) {
      throw new ModelError("PROVIDER_UNAVAILABLE", "LM Studio is not reachable. Start its local server on port 1234 and try again.");
    }
    throw new ModelError("PROVIDER_ERROR", error.message.replace(/^[A-Z_]+: /, ""), { cause: error.cause });
  }

  const usableFinalText = (candidate) => {
    const content = candidate.choices[0].message.content || "";
    if (!content.trim()) return "";
    try {
      return finalText(content);
    } catch (error) {
      // Some Qwen/LM Studio combinations emit only an unfinished reasoning
      // channel even when Thinking was disabled. Retry once with a plain
      // completion instead of exposing a spurious empty-generation error.
      if (error instanceof ModelError && error.code === "THINKING_TRUNCATED") return "";
      throw error;
    }
  };

  const text = usableFinalText(response);
  const usage = response.usage || {};
  const primaryFinishReason = response.choices[0].finish_reason;
  const thinkingAttemptTokens = thinking ? parseInt(usage.completion_tokens || 0, 10) : 0;

  let thinkingFallback = false;
  let finalResponse = response;
  if (!text.trim() || primaryFinishReason === "length") {
    thinkingFallback = true;
    const fallbackPayload = { ...payload, max_tokens: 1536, chat_template_kwargs: { enable_thinking: false } };
    finalResponse = await chatCompletion({ url, headers, payload: fallbackPayload, signal, onDelta });
    const fallbackUsage = finalResponse.usage || {};
    usage.completion_tokens = thinkingAttemptTokens + parseInt(fallbackUsage.completion_tokens || 0, 10);
    usage.prompt_tokens = fallbackUsage.prompt_tokens || usage.prompt_tokens || 0;
  }

  let prompt = usableFinalText(finalResponse);
  if (!prompt.trim()) {
    throw new ModelError(
      "EMPTY_GENERATION",
      "The model returned no final prompt after a retry with Thinking off. Try again or choose a different model.",
    );
  }
  const durationSeconds = assembled.input.duration_seconds;
  const intentText = assembled.input.creative_brief || [assembled.input.current_prompt, assembled.input.instruction].join("\n");
  const cameraStructureAllowed = cameraStructureRequested(intentText);

  let initialAudit = auditPrompt(prompt, assembled.input.mode, durationSeconds, cameraStructureAllowed);
  const userContent = assembled.messages.find((m) => m.role === "user").content;
  const expectedReferenceTags = referenceTags(userContent);
  const actualReferenceTags = referenceTags(prompt);
  const missingReferenceTags = [...expectedReferenceTags].filter((t) => !actualReferenceTags.has(t)).sort();
  const unexpectedReferenceTags = [...actualReferenceTags].filter((t) => !expectedReferenceTags.has(t)).sort();
  const hasUnexpectedAudioTask = unexpectedAudioTask(initialAudit.task_label, expectedReferenceTags);
  const constraintViolations = explicitConstraintViolations(intentText, prompt);

  if (assembled.input.mode === "Reference") {
    initialAudit.missing_reference_tags = missingReferenceTags;
    initialAudit.unexpected_reference_tags = unexpectedReferenceTags;
    initialAudit.unexpected_audio_task = hasUnexpectedAudioTask;
    initialAudit.explicit_constraint_violations = constraintViolations;
    initialAudit.repair_required = !!(
      initialAudit.repair_required ||
      missingReferenceTags.length ||
      unexpectedReferenceTags.length ||
      hasUnexpectedAudioTask ||
      constraintViolations.length
    );
  }

  let formatRepairAttempted = false;
  let formatRepairApplied = false;
  let formatRepairTokens = 0;
  let formatRepairReason = null;
  let formatRepairFailure = null;
  let formatRepairMethod = null;

  if (assembled.input.mode === "Reference" && initialAudit.repair_required) {
    formatRepairAttempted = true;
    const failedChecks = auditFailures(initialAudit);
    formatRepairReason = failedChecks.join(", ") || "official format audit";
    formatRepairMethod = "narrow text correction";
    const repairMessages = narrowRepairMessages(assembled, prompt, failedChecks, expectedReferenceTags, durationSeconds);
    const repairPayload = {
      model,
      messages: repairMessages,
      temperature: 0.3,
      top_p: 0.9,
      top_k: 40,
      max_tokens: STANDARD_OUTPUT_TOKENS,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    };
    if (seed !== undefined && seed !== null) repairPayload.seed = seed;
    let repairResponse;
    try {
      repairResponse = await chatCompletion({ url, headers, payload: repairPayload, signal });
    } catch (error) {
      if (error.message.startsWith("GENERATION_CANCELLED")) throw error;
      formatRepairFailure = `repair request failed: ${error.message}`;
    }
    if (repairResponse) {
      formatRepairTokens = parseInt(repairResponse.usage?.completion_tokens || 0, 10);
      const repairedRaw = repairResponse.choices[0].message.content || "";
      const repaired = finalText(repairedRaw);
      const repairedAudit = auditPrompt(repaired, assembled.input.mode, durationSeconds, cameraStructureAllowed);
      const repairedTags = referenceTags(repaired);
      repairedAudit.missing_reference_tags = [...expectedReferenceTags].filter((t) => !repairedTags.has(t)).sort();
      repairedAudit.unexpected_reference_tags = [...repairedTags].filter((t) => !expectedReferenceTags.has(t)).sort();
      repairedAudit.unexpected_audio_task = unexpectedAudioTask(repairedAudit.task_label, expectedReferenceTags);
      repairedAudit.explicit_constraint_violations = explicitConstraintViolations(intentText, repaired);
      repairedAudit.repair_required = !!(
        repairedAudit.repair_required ||
        repairedAudit.missing_reference_tags.length ||
        repairedAudit.unexpected_reference_tags.length ||
        repairedAudit.unexpected_audio_task ||
        repairedAudit.explicit_constraint_violations.length
      );
      const repairTagsMatch = repairedTags.size === expectedReferenceTags.size &&
        [...repairedTags].every((t) => expectedReferenceTags.has(t));
      const dialoguePreserved = JSON.stringify(dialogueLines(repaired)) === JSON.stringify(dialogueLines(prompt));
      if (repaired && !repairedAudit.repair_required && repairTagsMatch && dialoguePreserved) {
        prompt = repaired;
        formatRepairApplied = true;
        initialAudit = repairedAudit;
      } else if (!repaired) {
        formatRepairFailure = "empty repair";
      } else if (repairedAudit.repair_required) {
        formatRepairFailure = "repaired draft still failed: " + auditFailures(repairedAudit).join(", ");
      } else {
        formatRepairFailure = "correction changed the reference inventory or user dialogue";
      }
      usage.completion_tokens = parseInt(usage.completion_tokens || 0, 10) + formatRepairTokens;
    }
  }

  return {
    prompt,
    prompt_audit: initialAudit,
    input_tokens: parseInt(usage.prompt_tokens || 0, 10),
    output_tokens: parseInt(usage.completion_tokens || 0, 10),
    thinking_fallback: thinkingFallback,
    thinking_attempt_tokens: thinkingAttemptTokens,
    primary_finish_reason: primaryFinishReason,
    format_repair_attempted: formatRepairAttempted,
    format_repair_applied: formatRepairApplied,
    format_repair_reason: formatRepairReason,
    format_repair_failure: formatRepairFailure,
    format_repair_method: formatRepairMethod,
    format_repair_tokens: formatRepairTokens,
    ...metrics,
  };
}
