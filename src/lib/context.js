export const CONTEXT_PROFILES = { low: 8192, standard: 16384, extended: 24576 };
export const CONTEXT_PROFILE_ALIASES = { "8k": "low", "16k": "standard", "24k": "extended" };
export const KV_CACHE_PROFILES = ["auto", "q8", "f16"];
export const CONTEXT_SAFETY_TOKENS = 512;
export const ESTIMATED_VISUAL_TOKENS = 280;
export const CHAT_TEMPLATE_OVERHEAD_TOKENS = 384;
export const STANDARD_OUTPUT_TOKENS = 1536;
export const THINKING_OUTPUT_TOKENS = 6144;

export class ContextPlanError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.message = message;
    this.details = details;
  }
}

export function resolveContextProfile(requested, modelInfo) {
  let value = (requested || "auto").trim().toLowerCase();
  value = CONTEXT_PROFILE_ALIASES[value] || value;
  if (value === "auto") {
    const recommended = String(modelInfo?.recommended_context || "standard").toLowerCase();
    return CONTEXT_PROFILES[recommended] ? recommended : "standard";
  }
  if (!(value in CONTEXT_PROFILES)) {
    throw new ContextPlanError(
      "INVALID_CONTEXT_PROFILE",
      "Context must be Auto, Low 8K, Standard 16K, or Extended 24K.",
      { context_profile: requested },
    );
  }
  return value;
}

export function resolveKvCache(requested) {
  const value = (requested || "auto").trim().toLowerCase();
  if (!KV_CACHE_PROFILES.includes(value)) {
    throw new ContextPlanError("INVALID_KV_CACHE", "KV cache must be Auto, Q8, or F16.", { kv_cache: requested });
  }
  return value === "auto" ? "q8" : value;
}

export function estimateTextTokens(text) {
  const encoded = Buffer.from(text, "utf8");
  return Math.ceil(Math.max(text.length / 3.0, encoded.length / 3.0));
}

function _assembledText(assembled) {
  return (assembled.messages || [])
    .filter((m) => typeof m.content === "string")
    .map((m) => String(m.content || ""))
    .join("\n\n");
}

export function planContext(assembled, modelInfo, { requestedContext, requestedKvCache, thinking }) {
  let requestedValue = (requestedContext || "auto").trim().toLowerCase();
  requestedValue = CONTEXT_PROFILE_ALIASES[requestedValue] || requestedValue;
  const automatic = requestedValue === "auto";
  const profile = resolveContextProfile(requestedContext, modelInfo);
  const kvCache = resolveKvCache(requestedKvCache);
  const visualInputCount = (assembled.media_inputs || []).filter(
    (item) => item.type === "image" || item.type === "video",
  ).length;
  const estimatedTextTokens = estimateTextTokens(_assembledText(assembled));
  const estimatedInputTokens =
    estimatedTextTokens + visualInputCount * ESTIMATED_VISUAL_TOKENS + CHAT_TEMPLATE_OVERHEAD_TOKENS;
  const minimumRequired = estimatedInputTokens + STANDARD_OUTPUT_TOKENS + CONTEXT_SAFETY_TOKENS;
  let finalProfile = profile;
  if (automatic && finalProfile === "low" && (thinking || minimumRequired > CONTEXT_PROFILES.low)) {
    finalProfile = "standard";
  }
  const contextTokens = CONTEXT_PROFILES[finalProfile];
  if (finalProfile === "low" && thinking) {
    throw new ContextPlanError(
      "THINKING_DISABLED_LOW_CONTEXT",
      "Thinking is unavailable in Low 8K context. Switch to Standard 16K or turn Thinking off.",
      { context_profile: finalProfile, context_tokens: contextTokens, suggested_context_profile: "standard" },
    );
  }
  if (minimumRequired > contextTokens) {
    const suggested = Object.entries(CONTEXT_PROFILES).find(
      ([, tokens]) => tokens >= minimumRequired && tokens > contextTokens,
    )?.[0] || null;
    throw new ContextPlanError(
      "CONTEXT_BUDGET_EXCEEDED",
      "This request does not leave enough context for a complete MiniMax prompt.",
      {
        estimated_input_tokens: estimatedInputTokens,
        minimum_output_tokens: STANDARD_OUTPUT_TOKENS,
        safety_tokens: CONTEXT_SAFETY_TOKENS,
        context_profile: finalProfile,
        context_tokens: contextTokens,
        suggested_context_profile: suggested,
        suggestion: suggested
          ? `Switch to ${suggested.charAt(0).toUpperCase() + suggested.slice(1)} context or remove references.`
          : "Remove references or shorten the creative brief.",
      },
    );
  }
  const availableOutputTokens = contextTokens - estimatedInputTokens - CONTEXT_SAFETY_TOKENS;
  const maxOutputTokens = thinking
    ? Math.min(THINKING_OUTPUT_TOKENS, availableOutputTokens)
    : STANDARD_OUTPUT_TOKENS;
  return {
    requested_context_profile: requestedContext || "auto",
    context_profile: finalProfile,
    context_tokens: contextTokens,
    requested_kv_cache: requestedKvCache || "auto",
    kv_cache: kvCache,
    thinking,
    estimated_text_tokens: estimatedTextTokens,
    estimated_input_tokens: estimatedInputTokens,
    visual_input_count: visualInputCount,
    max_output_tokens: maxOutputTokens,
    reserved_output_tokens: maxOutputTokens + CONTEXT_SAFETY_TOKENS,
    thinking_budget_reduced: thinking && maxOutputTokens < THINKING_OUTPUT_TOKENS,
  };
}