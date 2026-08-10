import { readFileSync } from "node:fs";
import { extname } from "node:path";

function dataUri(path) {
  const ext = extname(path).toLowerCase();
  const mime = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  }[ext] || "image/jpeg";
  const encoded = readFileSync(path).toString("base64");
  return `data:${mime};base64,${encoded}`;
}

// Build OpenAI-compatible messages from the assembled request, embedding
// image/video contact-sheet frames as data URIs. Qwen multimodal input uses
// the standard image_url content part shape that both LM Studio and
// OpenRouter forward to Qwen models.
export function buildChatMessages(assembled, sessionStore) {
  const system = assembled.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const userText = assembled.messages.find((m) => m.role === "user").content;
  const content = [];
  const debugParts = [];
  const mediaInputs = [...(assembled.media_inputs || [])].sort(
    (a, b) => ({ image: 0, video: 1, audio: 2 }[a.type] ?? 3) - ({ image: 0, video: 1, audio: 2 }[b.type] ?? 3),
  );
  let imageCount = 0;
  let videoFrameCount = 0;
  let videoSheetCount = 0;
  for (const item of mediaInputs) {
    const asset = sessionStore.get(assembled.input.media_manifest.session_id, item.asset_id);
    if (item.type === "image") {
      const binding = `${item.reference}: image reference.`;
      content.push({ type: "text", text: binding });
      content.push({ type: "image_url", image_url: { url: dataUri(asset._prepared_path || asset._original_path) } });
      debugParts.push({ type: "text", text: binding, source: item.reference, representation: "prepared image" });
      imageCount++;
    } else if (item.type === "video") {
      const sheetPath = asset._contact_sheet_path;
      if (!sheetPath) throw new Error(`Internal contact sheet for ${item.reference} is missing.`);
      videoSheetCount++;
      videoFrameCount += (asset._frames || []).length;
      const binding =
        `${item.reference}: one ordered contact sheet sampled from this same video. ` +
        "Read frames left-to-right, then top-to-bottom, using the displayed order and the accompanying manifest timestamps to infer motion. " +
        `This sheet is only the internal visual representation of ${item.reference}; it is not a <Picture N> ` +
        "and must never change or renumber the external reference labels.";
      content.push({ type: "text", text: binding });
      content.push({ type: "image_url", image_url: { url: dataUri(sheetPath) } });
      debugParts.push({ type: "text", text: binding, source: item.reference, representation: "ordered video contact sheet" });
    }
  }
  content.push({ type: "text", text: userText });
  debugParts.push({ type: "text", text: userText });
  const messages = [
    { role: "system", content: system },
    { role: "user", content },
  ];
  return {
    messages,
    metrics: {
      visual_input_count: imageCount + videoSheetCount,
      video_frame_count: videoFrameCount,
      video_sheet_count: videoSheetCount,
      debug_input_sequence: [
        {
          role: "system",
          parts: assembled.messages.filter((m) => m.role === "system").map((m) => ({
            type: "text",
            source: m.name || "system",
            text: m.content,
          })),
        },
        { role: "user", parts: debugParts },
      ],
    },
  };
}

// Parse an SSE stream from an OpenAI-compatible chat completions endpoint.
// Yields { content, finishReason, usage } as chunks arrive. Returns the
// accumulated result when the stream closes.
export async function streamChatCompletion({ url, headers, payload, signal, onDelta }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch { detail = await res.text().catch(() => null); }
    const message = detail?.error?.message || `Provider returned HTTP ${res.status}`;
    const code = res.status === 401 ? "AUTH_FAILURE" : res.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR";
    throw new Error(`${code}: ${message}`, { cause: { status: res.status, detail } });
  }
  if (!res.body) throw new Error("PROVIDER_ERROR: No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = null;
  let usage = {};

  while (true) {
    if (signal?.aborted) throw new Error("GENERATION_CANCELLED: Generation was cancelled.");
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const event = trimmed.slice(5).trim();
      if (event === "[DONE]") continue;
      try {
        const chunk = JSON.parse(event);
      } catch { continue; }
      let chunk;
      try { chunk = JSON.parse(event); } catch { continue; }
      if (chunk.usage) usage = chunk.usage;
      const choices = chunk.choices;
      if (!Array.isArray(choices) || !choices.length) continue;
      const choice = choices[0];
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        if (onDelta) onDelta(delta.content);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  if (!usage || !usage.prompt_tokens) {
    usage = {
      prompt_tokens: 0,
      completion_tokens: Math.ceil(content.length / 3),
      ...usage,
    };
  }
  return {
    choices: [{ message: { content }, finish_reason: finishReason || "stop" }],
    usage,
  };
}