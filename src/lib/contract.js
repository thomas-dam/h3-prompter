export class ModelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.message = message;
    this.details = details;
  }
}

// Qwen-aware final text extraction. Qwen chat templates can leak special tokens
// and thinking markers into completions; strip them mechanically. Never rephrase.
export function finalText(response) {
  let text = response;

  // Qwen thinking-block markers. If thinking started but never produced a final
  // answer, treat as truncated (matches upstream behaviour for thinking models).
  const thinkingOpen = /<\|im_start\|>thought/i.test(text) || /<think>/i.test(text);
  const thinkingClose = /<\|im_end\|>thought/i.test(text) || /<\/think>/i.test(text);
  if (thinkingOpen && !thinkingClose) {
    throw new ModelError(
      "THINKING_TRUNCATED",
      "Thinking reached its token limit before producing the final prompt. Try again or turn Thinking off.",
    );
  }

  // Drop a leading thinking block if present and keep only what follows.
  if (/<\/think>/i.test(text)) {
    text = text.split(/<\/think>/i).pop();
  }
  if (/<\|im_end\|>thought/i.test(text)) {
    text = text.split(/<\|im_end\|>thought/i).pop();
  }

  // Strip Qwen chat-template artifacts and end-of-turn tokens.
  text = text
    .replace(/<\|im_start\|>/g, "")
    .replace(/<\|im_end\|>/g, "")
    .replace(/<\|endoftext\|>/g, "")
    .replace(/<eos>/g, "")
    .trim();

  return text;
}