const API = "/h3studio";
let sessionId = null;

function $(id) { return document.getElementById(id); }

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`);
  return data;
}

function setStatus(text, cls) {
  const badge = $("status-badge");
  badge.textContent = text;
  badge.className = cls || "";
}

// Load settings
async function loadSettings() {
  const { settings } = await api("/settings");
  $("provider").value = settings.provider || "lmstudio";
  $("model-id").value = settings.lmstudio_model_id || settings.openrouter_model_id || "";
  $("context-profile").value = settings.lmstudio_context_profile || "auto";
  $("kv-cache").value = settings.lmstudio_kv_cache || "auto";
  $("thinking").checked = settings.lmstudio_thinking || false;
  if (settings.openrouter_key) $("key-status").textContent = "Key stored in Keychain";
  toggleProviderUI();
}

function toggleProviderUI() {
  const provider = $("provider").value;
  $("openrouter-key-row").hidden = provider !== "openrouter";
}

// Save settings on change
function wireSettings() {
  $("provider").addEventListener("change", () => { toggleProviderUI(); saveSettings(); });
  $("model-id").addEventListener("change", saveSettings);
  $("context-profile").addEventListener("change", saveSettings);
  $("kv-cache").addEventListener("change", saveSettings);
  $("thinking").addEventListener("change", saveSettings);
  $("save-key").addEventListener("click", async () => {
    const key = $("openrouter-key").value.trim();
    if (!key) return;
    await api("/settings/openrouter-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    $("openrouter-key").value = "";
    $("key-status").textContent = "Key stored in Keychain";
  });
}

async function saveSettings() {
  const provider = $("provider").value;
  const body = {
    provider,
    [`${provider}_model_id`]: $("model-id").value,
    [`${provider}_context_profile`]: $("context-profile").value,
    [`${provider}_kv_cache`]: $("kv-cache").value,
    [`${provider}_thinking`]: $("thinking").checked,
  };
  await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Media upload
function wireMedia() {
  const drop = $("media-drop");
  const input = $("media-input");
  $("media-browse").addEventListener("click", (e) => { e.stopPropagation(); input.click(); });
  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => uploadFiles(input.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    uploadFiles(e.dataTransfer.files);
  });
}

async function uploadFiles(files) {
  if (!sessionId) sessionId = crypto.randomUUID();
  if (!files.length) return;
  const fd = new FormData();
  fd.append("session_id", sessionId);
  fd.append("mode", $("mode").value);
  for (const file of files) fd.append("file", file);
  try {
    setStatus("uploading...", "busy");
    await api("/media/upload", { method: "POST", body: fd });
    setStatus("idle");
    refreshMedia();
  } catch (e) {
    setStatus("error", "error");
    alert(e.message);
  }
}

async function refreshMedia() {
  if (!sessionId) return;
  const { assets } = await api(`/media?session_id=${sessionId}`);
  const list = $("media-list");
  list.innerHTML = "";
  for (const asset of assets) {
    const item = document.createElement("div");
    item.className = "media-item";
    const img = document.createElement("img");
    img.src = asset.preview_url || asset.content_url;
    img.alt = asset.filename;
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = asset.reference || asset.filename;
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "×";
    remove.addEventListener("click", async () => {
      await api(`/media/${asset.id}?session_id=${sessionId}`, { method: "DELETE" });
      refreshMedia();
    });
    item.append(img, label, remove);
    list.appendChild(item);
  }
}

// Generate
function wireGenerate() {
  $("generate-btn").addEventListener("click", generate);
  $("cancel-btn").addEventListener("click", () => api("/cancel", { method: "POST" }));
  $("copy-btn").addEventListener("click", () => navigator.clipboard.writeText($("output").value));
  $("refine-btn").addEventListener("click", refine);
}

async function generate() {
  if (!$("model-id").value) return alert("Enter a model ID in Settings.");
  if (!$("creative-brief").value.trim()) return alert("Enter a creative brief.");
  if (!sessionId) sessionId = crypto.randomUUID();

  $("generate-btn").disabled = true;
  $("cancel-btn").disabled = false;
  $("output").value = "";
  $("progress").textContent = "Starting...";
  setStatus("generating", "busy");
  $("audit-display").classList.remove("show");

  const body = {
    mode: $("mode").value,
    creative_brief: $("creative-brief").value,
    aspect_ratio: $("aspect-ratio").value,
    duration_seconds: parseFloat($("duration").value),
    model_id: $("model-id").value,
    provider: $("provider").value,
    session_id: sessionId,
    context_profile: $("context-profile").value,
    kv_cache: $("kv-cache").value,
    thinking: $("thinking").checked,
    seed: $("seed").value ? parseInt($("seed").value, 10) : undefined,
  };

  try {
    const res = await fetch(`${API}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const evt of events) {
        if (!evt.startsWith("data:")) continue;
        const data = JSON.parse(evt.slice(5).trim());
        handleEvent(data);
      }
    }
  } catch (e) {
    setStatus("error", "error");
    $("progress").textContent = e.message;
  } finally {
    $("generate-btn").disabled = false;
    $("cancel-btn").disabled = true;
  }
}

function handleEvent(data) {
  if (data.type === "phase") {
    $("progress").textContent = `Phase: ${data.phase}`;
  } else if (data.type === "delta") {
    $("output").value += data.content;
    $("progress").textContent = `Streaming... (${$("output").value.length} chars)`;
  } else if (data.type === "complete") {
    const { result } = data;
    $("output").value = result.prompt;
    setStatus("idle");
    $("progress").textContent = `Done in ${result.input_tokens || 0}→${result.output_tokens || 0} tokens.`;
    showAudit(result.prompt_audit);
    $("refine-row").hidden = false;
  } else if (data.type === "cancelled") {
    setStatus("idle");
    $("progress").textContent = "Cancelled.";
  } else if (data.type === "error") {
    setStatus("error", "error");
    $("progress").textContent = data.error.message;
  }
}

function showAudit(audit) {
  const el = $("audit-display");
  if (!audit) { el.classList.remove("show"); return; }
  el.classList.add("show");
  if (audit.official_format_pass) {
    el.className = "show pass";
    el.textContent = "Audit: PASSED";
  } else {
    el.className = "show fail";
    const issues = [
      ...(audit.missing_sections || []).map((s) => `missing: ${s}`),
      ...(audit.invalid_timestamps || []).map((t) => `invalid timestamp: ${t}`),
      ...(audit.internal_video_representation_terms || []).map((t) => `internal term: ${t}`),
      ...(audit.missing_reference_tags || []).map((t) => `missing tag: ${t}`),
      ...(audit.unexpected_reference_tags || []).map((t) => `unexpected tag: ${t}`),
      ...(audit.explicit_constraint_violations || []),
    ];
    el.textContent = "Audit: " + (issues.length ? issues.join("; ") : "needs review");
  }
}

async function refine() {
  const instruction = $("refine-instruction").value.trim();
  if (!instruction) return;
  if (!$("output").value) return alert("Generate a prompt first.");

  $("generate-btn").disabled = true;
  $("cancel-btn").disabled = false;
  setStatus("refining", "busy");
  $("progress").textContent = "Refining...";

  const body = {
    mode: $("mode").value,
    current_prompt: $("output").value,
    instruction,
    model_id: $("model-id").value,
    provider: $("provider").value,
    session_id: sessionId,
    context_profile: $("context-profile").value,
    kv_cache: $("kv-cache").value,
    thinking: $("thinking").checked,
    seed: $("seed").value ? parseInt($("seed").value, 10) : undefined,
  };

  try {
    const res = await fetch(`${API}/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const evt of events) {
        if (!evt.startsWith("data:")) continue;
        handleEvent(JSON.parse(evt.slice(5).trim()));
      }
    }
  } catch (e) {
    setStatus("error", "error");
    $("progress").textContent = e.message;
  } finally {
    $("generate-btn").disabled = false;
    $("cancel-btn").disabled = true;
  }
}

// Init
loadSettings().then(() => {
  wireSettings();
  wireMedia();
  wireGenerate();
  setStatus("idle");
  $("mode").addEventListener("change", refreshMedia);
});