const API = "/h3studio";

const MODE_CONFIG = {
  T2VA: {
    media: false,
    guidance: "No references are needed for text-only generation.",
    accept: "",
  },
  I2VA: {
    media: true,
    guidance: "Add the single image that should become the first frame.",
    accept: "image/*",
    requiredImages: 1,
  },
  FL2VA: {
    media: true,
    guidance: "Add the first frame, then the last frame, in that order.",
    accept: "image/*",
    requiredImages: 2,
  },
  L2VA: {
    media: true,
    guidance: "Add the image the video should arrive at.",
    accept: "image/*",
    requiredImages: 1,
  },
  Reference: {
    media: true,
    guidance: "Add at least one image or video. You can combine up to 9 images, 3 videos, and 3 audio clips.",
    accept: "image/*,video/*,audio/*",
    requiredVisuals: 1,
  },
};

const state = {
  sessionId: null,
  settings: {},
  activeProvider: "lmstudio",
  providerStatuses: null,
  assets: [],
  busy: false,
  lastError: null,
};

function $(id) { return document.getElementById(id); }

async function api(path, options) {
  const response = await fetch(`${API}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Request failed (${response.status})`);
    error.code = data?.error?.code;
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}

function setStatus(text, className = "") {
  const badge = $("status-badge");
  badge.textContent = text;
  badge.className = className;
}

function currentMode() { return $("mode").value; }
function modelControl(provider = state.activeProvider) {
  return provider === "lmstudio" ? $("lmstudio-model-id") : $("openrouter-model-id");
}
function currentModelId() { return modelControl().value.trim(); }

function renderLmStudioModelOptions() {
  const select = $("lmstudio-model-id");
  const selectedId = state.settings.lmstudio_model_id || select.value;
  const status = state.providerStatuses?.providers?.lmstudio;
  const models = status?.models || [];
  const placeholder = !status
    ? "Checking LM Studio…"
    : !status.connected
      ? "LM Studio is offline"
      : models.length
        ? "Choose a model…"
        : "No models reported by LM Studio";

  select.replaceChildren();
  const empty = new Option(placeholder, "");
  empty.disabled = !models.length;
  select.add(empty);
  for (const id of [...models].sort((a, b) => a.localeCompare(b))) {
    select.add(new Option(id, id));
  }
  if (selectedId && !models.includes(selectedId)) {
    select.add(new Option(`${selectedId} (not available)`, selectedId));
  }
  select.value = selectedId;
}

function captureProviderControls(provider = state.activeProvider) {
  state.settings[`${provider}_model_id`] = modelControl(provider).value.trim();
  state.settings[`${provider}_context_profile`] = $("context-profile").value;
  state.settings[`${provider}_kv_cache`] = $("kv-cache").value;
  state.settings[`${provider}_thinking`] = $("thinking").checked;
}

function applyProviderControls() {
  const provider = state.activeProvider;
  $("provider").value = provider;
  renderLmStudioModelOptions();
  $("lmstudio-model-id").hidden = provider !== "lmstudio";
  $("lmstudio-model-label").hidden = provider !== "lmstudio";
  $("lmstudio-model-note").hidden = provider !== "lmstudio";
  $("openrouter-model-id").hidden = provider !== "openrouter";
  $("openrouter-model-label").hidden = provider !== "openrouter";
  $("openrouter-model-id").value = state.settings.openrouter_model_id || "";
  $("context-profile").value = state.settings[`${provider}_context_profile`] || "auto";
  $("kv-cache").value = state.settings[`${provider}_kv_cache`] || "auto";
  $("thinking").checked = !!state.settings[`${provider}_thinking`];
  $("openrouter-key-row").hidden = provider !== "openrouter";
}

function settingsPayload() {
  return {
    provider: state.activeProvider,
    lmstudio_model_id: state.settings.lmstudio_model_id || "",
    lmstudio_context_profile: state.settings.lmstudio_context_profile || "auto",
    lmstudio_kv_cache: state.settings.lmstudio_kv_cache || "auto",
    lmstudio_thinking: !!state.settings.lmstudio_thinking,
    openrouter_model_id: state.settings.openrouter_model_id || "",
    openrouter_context_profile: state.settings.openrouter_context_profile || "auto",
    openrouter_kv_cache: state.settings.openrouter_kv_cache || "auto",
    openrouter_thinking: !!state.settings.openrouter_thinking,
  };
}

async function persistSettings() {
  captureProviderControls();
  await api("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settingsPayload()),
  });
}

async function loadSettings() {
  const { settings } = await api("/settings");
  state.settings = settings;
  state.activeProvider = settings.provider || "lmstudio";
  applyProviderControls();
  if (settings.openrouter_key) {
    $("key-status").textContent = "An API key is stored securely in macOS Keychain.";
  }
}

function activeProviderStatus() {
  return state.providerStatuses?.providers?.[state.activeProvider] || null;
}

function renderProviderStatus() {
  const status = activeProviderStatus();
  const message = $("provider-message");
  const summary = $("connection-summary");

  if (!status) {
    message.textContent = "Checking the selected provider…";
    message.className = "provider-message";
    summary.textContent = "Checking setup…";
    summary.className = "connection-summary";
    return;
  }

  message.textContent = status.message;
  message.className = `provider-message ${status.ready ? "ready" : "warning"}`;
  summary.className = `connection-summary ${status.ready ? "ready" : "warning"}`;

  if (state.activeProvider === "lmstudio") {
    renderLmStudioModelOptions();
    summary.textContent = status.ready
      ? "Model available"
      : status.connected
        ? "Model setup needed"
        : "LM Studio offline";
  } else {
    summary.textContent = status.ready ? "OpenRouter configured" : "OpenRouter setup needed";
  }

  if (!state.busy) {
    setStatus(status.ready ? "Ready" : "Setup needed", status.ready ? "ready" : "warning");
  }
}

async function refreshProviderStatus() {
  try {
    state.providerStatuses = await api("/provider-status");
    renderProviderStatus();
  } catch (error) {
    state.providerStatuses = null;
    $("provider-message").textContent = `Could not check the model connection: ${error.message}`;
    $("provider-message").className = "provider-message error";
    setStatus("Connection error", "error");
  }
  updateReadiness();
}

function requiredMediaMessage(mode = currentMode()) {
  const config = MODE_CONFIG[mode];
  const imageCount = state.assets.filter((asset) => asset.type === "image").length;
  const visualCount = state.assets.filter((asset) => asset.type === "image" || asset.type === "video").length;
  if (config.requiredImages && imageCount < config.requiredImages) {
    const remaining = config.requiredImages - imageCount;
    return `Add ${remaining} more image${remaining === 1 ? "" : "s"} for this mode.`;
  }
  if (config.requiredVisuals && visualCount < config.requiredVisuals) {
    return "Add at least one image or video for Reference mix.";
  }
  return null;
}

function readinessProblem() {
  const modelId = currentModelId();
  if (!modelId) return state.activeProvider === "lmstudio"
    ? "Choose a model from the Model connection panel above."
    : "Enter the model ID in the Model connection panel above.";
  const provider = activeProviderStatus();
  if (state.activeProvider === "lmstudio") {
    if (!provider?.connected) return provider?.message || "Start LM Studio’s local server on port 1234.";
    if (!provider.models?.includes(modelId)) return `LM Studio is running, but “${modelId}” is not available.`;
  } else if (!provider?.has_key) {
    return provider?.message || "Save an OpenRouter API key to continue.";
  }
  const mediaProblem = requiredMediaMessage();
  if (mediaProblem) return mediaProblem;
  if (!$("creative-brief").value.trim()) return "Describe what should happen in the video.";
  const duration = Number($("duration").value);
  if (!Number.isFinite(duration) || duration < 1 || duration > 20) return "Choose a length between 1 and 20 seconds.";
  return null;
}

function updateReadiness() {
  const readiness = $("readiness");
  if (state.busy) {
    readiness.textContent = "Your prompt is being written. You can cancel at any time.";
    readiness.className = "readiness";
    $("generate-btn").disabled = true;
    return;
  }

  const problem = readinessProblem();
  readiness.textContent = problem || "Everything is ready. Generate the H3 prompt when you’re happy with the brief.";
  readiness.className = `readiness ${problem ? "warning" : "ready"}`;
  $("generate-btn").disabled = !!problem;
}

function renderMode() {
  const mode = currentMode();
  const config = MODE_CONFIG[mode];
  for (const button of document.querySelectorAll(".mode-card")) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }

  $("media-panel").hidden = !config.media;
  $("media-guidance").textContent = config.guidance;
  $("media-input").accept = config.accept;
  $("media-types").textContent = mode === "Reference"
    ? "Images, 2–15 second videos, and 2–15 second audio clips"
    : "Images only";
  updateMediaCount();
  updateReadiness();
}

function updateMediaCount() {
  const mode = currentMode();
  const config = MODE_CONFIG[mode];
  const count = $("media-count");
  if (!config.media) return;

  const images = state.assets.filter((asset) => asset.type === "image").length;
  const visuals = state.assets.filter((asset) => asset.type === "image" || asset.type === "video").length;
  if (config.requiredImages) {
    count.textContent = `${images} of ${config.requiredImages} image${config.requiredImages === 1 ? "" : "s"}`;
    count.className = `media-count ${images >= config.requiredImages ? "ready" : ""}`;
  } else {
    count.textContent = `${state.assets.length} reference${state.assets.length === 1 ? "" : "s"}`;
    count.className = `media-count ${visuals >= config.requiredVisuals ? "ready" : ""}`;
  }
}

function renderMedia() {
  const list = $("media-list");
  list.innerHTML = "";
  for (const asset of state.assets) {
    const item = document.createElement("div");
    item.className = "media-item";

    const preview = document.createElement("img");
    preview.src = asset.preview_url || asset.content_url;
    preview.alt = asset.filename;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = asset.reference || asset.filename;
    label.title = asset.filename;

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${asset.filename}`);
    remove.addEventListener("click", async () => {
      await api(`/media/${asset.id}?session_id=${state.sessionId}`, { method: "DELETE" });
      await refreshMedia();
    });

    item.append(preview, label, remove);
    list.appendChild(item);
  }
  updateMediaCount();
  updateReadiness();
}

async function refreshMedia() {
  if (!state.sessionId) {
    state.assets = [];
    renderMedia();
    return;
  }
  const manifest = await api(`/media/manifest?session_id=${state.sessionId}&mode=${encodeURIComponent(currentMode())}`);
  state.assets = manifest.assets || [];
  renderMedia();
}

async function uploadFiles(files) {
  if (!files?.length || state.busy) return;
  if (!state.sessionId) state.sessionId = crypto.randomUUID();

  const form = new FormData();
  form.append("session_id", state.sessionId);
  form.append("mode", currentMode());
  for (const file of files) form.append("file", file);

  state.busy = true;
  setStatus("Uploading", "busy");
  $("progress").textContent = "Preparing reference media…";
  updateReadiness();
  try {
    await api("/media/upload", { method: "POST", body: form });
    await refreshMedia();
    $("progress").textContent = "References ready.";
  } catch (error) {
    state.lastError = error.message;
    $("progress").textContent = error.message;
    setStatus("Upload error", "error");
  } finally {
    state.busy = false;
    $("media-input").value = "";
    renderProviderStatus();
    updateReadiness();
  }
}

function generationBody() {
  return {
    mode: currentMode(),
    creative_brief: $("creative-brief").value.trim(),
    aspect_ratio: $("aspect-ratio").value,
    duration_seconds: Number($("duration").value),
    model_id: currentModelId(),
    provider: state.activeProvider,
    session_id: state.sessionId,
    context_profile: $("context-profile").value,
    kv_cache: $("kv-cache").value,
    thinking: $("thinking").checked,
    seed: $("seed").value ? Number.parseInt($("seed").value, 10) : undefined,
  };
}

async function streamRequest(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error("The provider returned no response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      if (!event.startsWith("data:")) continue;
      handleEvent(JSON.parse(event.slice(5).trim()));
    }
  }
}

function beginGeneration(label) {
  state.busy = true;
  state.lastError = null;
  $("generate-btn").disabled = true;
  $("cancel-btn").disabled = false;
  $("copy-btn").disabled = true;
  $("audit-display").className = "";
  $("progress").textContent = label;
  setStatus("Writing", "busy");
  updateReadiness();
}

async function generate() {
  const problem = readinessProblem();
  if (problem) {
    $("progress").textContent = problem;
    return;
  }
  if (!state.sessionId) state.sessionId = crypto.randomUUID();
  $("output").value = "";
  $("refine-row").hidden = true;
  beginGeneration("Starting the prompt…");
  try {
    await streamRequest("/generate", generationBody());
  } catch (error) {
    handleFailure(error);
  } finally {
    finishGeneration();
  }
}

function handleEvent(data) {
  if (data.type === "phase") {
    $("progress").textContent = "Reading your brief and applying the H3 guide…";
  } else if (data.type === "delta") {
    $("output").value += data.content;
    $("progress").textContent = `Writing… ${$("output").value.length.toLocaleString()} characters`;
  } else if (data.type === "complete") {
    const { result } = data;
    $("output").value = result.prompt;
    $("copy-btn").disabled = false;
    $("progress").textContent = `Done · ${result.input_tokens || 0} input / ${result.output_tokens || 0} output tokens`;
    $("refine-row").hidden = false;
    showAudit(result.prompt_audit);
    setStatus("Ready", "ready");
  } else if (data.type === "cancelled") {
    state.lastError = "cancelled";
    $("progress").textContent = "Generation cancelled.";
    setStatus("Ready", "ready");
  } else if (data.type === "error") {
    state.lastError = data.error.message;
    $("progress").textContent = data.error.message;
    setStatus("Generation error", "error");
  }
}

function handleFailure(error) {
  state.lastError = error.message;
  $("progress").textContent = error.message;
  setStatus("Generation error", "error");
}

function finishGeneration() {
  state.busy = false;
  $("cancel-btn").disabled = true;
  updateReadiness();
  if (!state.lastError) renderProviderStatus();
}

function showAudit(audit) {
  const display = $("audit-display");
  if (!audit || audit.official_format_pass === null) {
    display.className = "";
    display.textContent = "";
    return;
  }
  if (audit.official_format_pass) {
    display.className = "show pass";
    display.textContent = "Format check passed.";
    return;
  }

  const issues = [
    ...(audit.missing_sections || []).map((section) => `missing ${section}`),
    ...(audit.invalid_timestamps || []).map((timestamp) => `invalid timestamp ${timestamp}`),
    ...(audit.internal_video_representation_terms || []).map((term) => `internal term ${term}`),
    ...(audit.missing_reference_tags || []).map((tag) => `missing ${tag}`),
    ...(audit.unexpected_reference_tags || []).map((tag) => `unexpected ${tag}`),
    ...(audit.explicit_constraint_violations || []),
  ];
  display.className = "show fail";
  display.textContent = `Check the format: ${issues.length ? issues.join("; ") : "manual review recommended"}.`;
}

async function refine() {
  const instruction = $("refine-instruction").value.trim();
  if (!instruction || !$("output").value.trim()) return;
  beginGeneration("Applying your revision…");
  const body = {
    ...generationBody(),
    current_prompt: $("output").value,
    instruction,
  };
  delete body.creative_brief;
  delete body.aspect_ratio;
  delete body.duration_seconds;
  try {
    await streamRequest("/refine", body);
  } catch (error) {
    handleFailure(error);
  } finally {
    finishGeneration();
  }
}

function wireSettings() {
  $("provider").addEventListener("change", async () => {
    captureProviderControls(state.activeProvider);
    state.activeProvider = $("provider").value;
    applyProviderControls();
    await persistSettings();
    await refreshProviderStatus();
  });

  $("lmstudio-model-id").addEventListener("change", async () => {
    updateReadiness();
    await persistSettings();
    await refreshProviderStatus();
  });
  $("openrouter-model-id").addEventListener("input", updateReadiness);
  $("openrouter-model-id").addEventListener("change", async () => {
    await persistSettings();
    await refreshProviderStatus();
  });
  for (const id of ["context-profile", "kv-cache", "thinking"]) {
    $(id).addEventListener("change", persistSettings);
  }

  $("save-key").addEventListener("click", async () => {
    const key = $("openrouter-key").value.trim();
    if (!key) {
      $("key-status").textContent = "Enter a key before saving.";
      return;
    }
    await api("/settings/openrouter-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    $("openrouter-key").value = "";
    $("key-status").textContent = "API key saved securely in macOS Keychain.";
    await refreshProviderStatus();
  });
}

function wireModeAndBrief() {
  for (const button of document.querySelectorAll(".mode-card")) {
    button.addEventListener("click", async () => {
      $("mode").value = button.dataset.mode;
      state.assets = [];
      renderMode();
      await refreshMedia();
    });
  }
  $("creative-brief").addEventListener("input", () => {
    $("brief-count").textContent = `${$("creative-brief").value.length.toLocaleString()} / 2,000`;
    updateReadiness();
  });
  $("duration").addEventListener("input", updateReadiness);
}

function wireMedia() {
  const drop = $("media-drop");
  const input = $("media-input");
  $("media-browse").addEventListener("click", (event) => {
    event.stopPropagation();
    input.click();
  });
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => uploadFiles(input.files));
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dragover");
    uploadFiles(event.dataTransfer.files);
  });
}

function wireActions() {
  $("generate-btn").addEventListener("click", generate);
  $("cancel-btn").addEventListener("click", () => api("/cancel", { method: "POST" }));
  $("refine-btn").addEventListener("click", refine);
  $("copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("output").value);
    const button = $("copy-btn");
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = "Copy"; }, 1200);
  });
}

async function init() {
  try {
    await loadSettings();
    wireSettings();
    wireModeAndBrief();
    wireMedia();
    wireActions();
    renderMode();
    await refreshProviderStatus();
    if (!activeProviderStatus()?.ready) $("connection-panel").open = true;
  } catch (error) {
    $("readiness").textContent = `The app could not finish loading: ${error.message}`;
    $("readiness").className = "readiness error";
    setStatus("Load error", "error");
  }
}

init();
