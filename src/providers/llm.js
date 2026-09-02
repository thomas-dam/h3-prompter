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
  const originalRef2VA = assembled.input.workflow === 'original_ref2va';
  const system = assembled.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const userText = assembled.messages.find((m) => m.role === "user").content;
  const content = [];
  const debugParts = [];
  if (originalRef2VA) {
    content.push({ type: 'text', text: userText });
    debugParts.push({ type: 'text', text: userText });
  }
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
      if (!originalRef2VA) content.push({ type: "text", text: binding });
      const imagePath = originalRef2VA ? asset._original_path || asset._prepared_path : asset._prepared_path || asset._original_path;
      content.push({ type: "image_url", image_url: { url: dataUri(imagePath) } });
      debugParts.push({ type: "text", text: binding, source: item.reference, representation: originalRef2VA ? "original image" : "prepared image" });
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
  if (!originalRef2VA) {
    content.push({ type: "text", text: userText });
    debugParts.push({ type: "text", text: userText });
  }
  const messages = [
    { role: "system", content: system },
    { role: "user", content: originalRef2VA && !imageCount ? userText : content },
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
    method: "POST", headers: { Accept: "text/event-stream", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload), signal,
  });
  if (!res.ok) {
    const raw = await res.text();
    let detail; try { detail = JSON.parse(raw); } catch { detail = null; }
    const code = res.status === 401 ? "AUTH_FAILURE" : res.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_ERROR";
    throw new Error(code + ": " + (detail?.error?.message || "Provider returned HTTP " + res.status), { cause: { status: res.status } });
  }
  // Narrow repair deliberately requests a non-streaming JSON completion.
  if (res.headers.get("content-type")?.includes("application/json")) {
    const response = await res.json();
    if (!response.choices?.[0]?.message) throw new Error("PROVIDER_ERROR: Invalid completion response");
    if (onDelta && response.choices[0].message.content) onDelta(response.choices[0].message.content);
    return response;
  }
  if (!res.body) throw new Error("PROVIDER_ERROR: No response body");
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = "", content = "", finishReason = null, usage = {};
  function consume(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const event = trimmed.slice(5).trim();
    if (event === "[DONE]") return;
    let chunk; try { chunk = JSON.parse(event); } catch { throw new Error("PROVIDER_ERROR: Invalid streaming response"); }
    if (chunk.error) throw new Error("PROVIDER_ERROR: " + (chunk.error.message || "Stream failed"));
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.content === "string") { content += delta.content; onDelta?.(delta.content); }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) consume(line);
      if (done) { if (buffer.trim()) consume(buffer); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { choices: [{ message: { content }, finish_reason: finishReason || "stop" }], usage: { prompt_tokens: 0, completion_tokens: Math.ceil(content.length / 3), ...usage } };
}
