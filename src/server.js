import express from "express";
import { JOB } from "./lib/jobs.js";
import { mountStudio } from "./studio_routes.js";
import multer from "multer";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";

import { MODE_GUIDES, guideCatalog, guideForMode } from "./lib/guides.js";
import { systemPromptForMode, SystemPromptError } from "./lib/system_prompts.js";
import {
  ASPECT_RATIOS,
  AssemblyError,
  assembleRefinement,
  assembleRequest,
} from "./lib/assembly.js";
import {
  CACHE_ROOT,
  MAX_FILE_BYTES,
  MODE_LIMITS,
  MediaError,
  parseSessionId,
  STORE,
  mediaType,
  resetCache,
} from "./lib/media.js";
import { planContext, ContextPlanError } from "./lib/context.js";
import { ModelError } from "./lib/contract.js";
import { generate } from "./lib/generation.js";
import { recoverRef2VARequest } from "./lib/ref2va_original.js";
import { REF2VA_SYSTEM_PROMPT } from "./lib/ref2va_system_prompt.js";
import {
  loadSettings,
  saveSettings,
  redact,
  getOpenRouterKey,
  setOpenRouterKey,
  deleteOpenRouterKey,
  localBaseUrl,
} from "./lib/settings.js";

export async function ensureCache() {
  await resetCache();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTE_PREFIX = "/h3studio";
const MODES = new Set(["T2VA", "I2VA", "FL2VA", "L2VA", "Reference"]);

const STATE = JOB;


async function providerStatus() {
  const settings = loadSettings();
  const lmstudioModel = settings.lmstudio_model_id?.trim() || "";
  let lmstudio;

  try {
    const response = await fetch(`${localBaseUrl(settings)}/models`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload?.data)
      ? payload.data.map((model) => model?.id).filter(Boolean)
      : [];
    const modelAvailable = !lmstudioModel || models.includes(lmstudioModel);
    lmstudio = {
      connected: true,
      configured: !!lmstudioModel,
      ready: !!lmstudioModel && modelAvailable,
      model_available: modelAvailable,
      models,
      message: !lmstudioModel
        ? "LM Studio is running. Enter a model ID that appears in its model list."
        : modelAvailable
          ? `LM Studio is connected and “${lmstudioModel}” is available.`
          : `LM Studio is connected, but “${lmstudioModel}” is not available.`,
    };
  } catch {
    lmstudio = {
      connected: false,
      configured: !!lmstudioModel,
      ready: false,
      model_available: false,
      models: [],
      message: `Cannot reach LM Studio at ${localBaseUrl(settings)}. Start its server or check the address.`,
    };
  }

  const openrouterModel = settings.openrouter_model_id?.trim() || "";
  const hasOpenRouterKey = !!getOpenRouterKey();
  const openrouterConfigured = !!openrouterModel && hasOpenRouterKey;
  return {
    selected: settings.provider || "lmstudio",
    providers: {
      lmstudio,
      openrouter: {
        connected: null,
        configured: openrouterConfigured,
        ready: openrouterConfigured,
        verified: false,
        has_key: hasOpenRouterKey,
        message: !hasOpenRouterKey
          ? "Save an OpenRouter API key to continue."
          : !openrouterModel
            ? "Enter an OpenRouter model ID."
            : "Configured. The cloud connection is checked when you generate.",
      },
    },
  };
}

function errorResponse(code, message, status, details) {
  const payload = { error: { code, message } };
  if (details !== undefined) payload.error.details = details;
  return { status, json: payload };
}

function sendError(res, error) {
  if (error instanceof AssemblyError) return res.status(400).json(errorResponse(error.code, error.message, 400, error.details).json);
  if (error instanceof MediaError) return res.status(error.code === "MEDIA_NOT_FOUND" ? 404 : 400).json({ error: { code: error.code, message: error.message } });
  if (error instanceof ContextPlanError) return res.status(400).json({ error: { code: error.code, message: error.message, details: error.details } });
  if (error instanceof SystemPromptError) return res.status(400).json({ error: { code: error.code, message: error.message } });
  if (error instanceof ModelError) {
    const status = error.code === "AUTH_FAILURE" ? 401
      : error.code === "PROVIDER_UNAVAILABLE" ? 502
      : error.code === "GENERATION_CANCELLED" ? 499
      : 500;
    return res.status(status).json({ error: { code: error.code, message: error.message, details: error.details } });
  }
  console.error("Unhandled error:", error);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: error.message || "An internal error occurred." } });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        const sessionId = req._h3_session_id || parseSessionId(req.body?.session_id);
        req._h3_session_id = sessionId;
        const dir = join(CACHE_ROOT, sessionId, randomUUID());
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      } catch (error) { cb(error); }
    },
    filename: (req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase();
      cb(null, `original${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES },
});

export function createServer(options = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    // This is a personal local service, not a cross-origin upload/proxy endpoint.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return res.status(403).json({ error: { code: "ORIGIN_REJECTED", message: "Cross-origin requests are not allowed." } });
    if (STATE.active_request_id && req.path.startsWith("/h3studio/media") && req.method !== "GET") return res.status(409).json({ error: { code: "GENERATION_BUSY", message: "Wait for the active operation before changing media." } });
    next();
  });

  app.get(`${ROUTE_PREFIX}/status`, (req, res) => {
    res.json({
      phase: STATE.phase,
      active_request_id: STATE.active_request_id,
      backend_ready: true,
      version: "1.0.0",
    });
  });

  app.get(`${ROUTE_PREFIX}/provider-status`, async (req, res) => {
    res.json(await providerStatus());
  });

  app.get(`${ROUTE_PREFIX}/guides`, (req, res) => {
    res.json({ guides: guideCatalog() });
  });

  app.get(`${ROUTE_PREFIX}/guides/:mode`, (req, res) => {
    const mode = req.params.mode;
    if (!(mode in MODE_GUIDES)) return res.status(404).json({ error: { code: "INVALID_MODE", message: "The selected MiniMax mode is not supported." } });
    res.json({ guide: guideForMode(mode) });
  });

  app.get(`${ROUTE_PREFIX}/system-prompt/:mode`, (req, res) => {
    const mode = req.params.mode;
    try {
      const prompt = mode === 'Reference' ? REF2VA_SYSTEM_PROMPT : systemPromptForMode(mode);
      res.json({ mode, profile: mode === "Reference" ? "reference" : "standard", system_prompt: prompt });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/assemble`, async (req, res) => {
    try {
      const sessionId = parseSessionId(req.body?.session_id);
      const mode = req.body?.mode;
      const manifest = STORE.manifest(sessionId, mode);
      const assembled = recoverRef2VARequest(assembleRequest(req.body, { manifest }), req.body);
      res.json({ request: assembled });
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid session ID") {
        return res.status(400).json({ error: { code: "INVALID_SESSION", message: "The media session ID is invalid." } });
      }
      sendError(res, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/generate`, async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") return res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Expected a JSON object." } });
      const missing = ["mode", "creative_brief", "model_id", "session_id", "aspect_ratio", "duration_seconds"].filter((k) => !body[k]);
      if (missing.length) return res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Required fields are missing.", details: { fields: missing } } });
      if (!MODES.has(body.mode)) return res.status(400).json({ error: { code: "INVALID_MODE", message: "The selected MiniMax mode is not supported." } });
      if (STATE.active_request_id) return res.status(409).json({ error: { code: "GENERATION_BUSY", message: "Another H3 Prompt Writer request is already running." } });

      const provider = body.provider || "lmstudio";
      const settings = loadSettings();
      if (provider === "openrouter") settings.openrouter_key = getOpenRouterKey();

      const sessionId = parseSessionId(body.session_id);
      const manifest = STORE.manifest(sessionId, body.mode);
      const assembled = recoverRef2VARequest(assembleRequest(body, { manifest }), body);

      let runtimePlan;
      try {
        runtimePlan = planContext(assembled, { recommended_context: body.context_profile || "standard" }, {
          requestedContext: body.context_profile || "auto",
          requestedKvCache: body.kv_cache || "auto",
          thinking: !!body.thinking,
        });
      } catch (error) {
        return sendError(res, error);
      }

      const requestId = randomUUID();
      STATE.active_request_id = requestId;
      STATE.phase = "generating";
      JOB.controller = new AbortController();

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        sendEvent({ type: "phase", phase: "generating", request_id: requestId });
        const result = await generate({
          assembled,
          chatCompletion: options.chatCompletion,
          provider,
          modelId: body.model_id,
          settings,
          runtimePlan,
          thinking: !!body.thinking,
          seed: body.seed,
          temperature: 0.4,
          sessionStore: STORE,
          signal: JOB.controller.signal,
          onDelta: (delta) => {
            sendEvent({ type: "delta", content: delta });
          },
        });
        sendEvent({ type: "complete", result: { request_id: requestId, model_id: body.model_id, thinking: !!body.thinking, ...result } });
      } catch (error) {
        if (error.message?.startsWith("GENERATION_CANCELLED") || error.code === "GENERATION_CANCELLED") {
          sendEvent({ type: "cancelled", request_id: requestId });
        } else {
          sendEvent({ type: "error", error: { code: error.code || "PROVIDER_ERROR", message: error.message, details: error.details } });
        }
      } finally {
        STATE.active_request_id = null;
        STATE.phase = "idle";
        JOB.controller = null;
        res.end();
      }
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/cancel`, (req, res) => {
    if (!STATE.active_request_id) return res.json({ cancelled: false, reason: "idle" });
    STATE.phase = "cancelling";
    JOB.controller?.abort();
    res.json({ cancelled: true });
  });

  app.post(`${ROUTE_PREFIX}/refine`, async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object") return res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Expected a JSON object." } });
      const missing = ["current_prompt", "instruction", "model_id", "session_id", "mode"].filter((k) => !body[k]);
      if (missing.length) return res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Required fields are missing.", details: { fields: missing } } });
      if (STATE.active_request_id) return res.status(409).json({ error: { code: "GENERATION_BUSY", message: "Another H3 Prompt Writer request is already running." } });

      const provider = body.provider || "lmstudio";
      const settings = loadSettings();
      if (provider === "openrouter") settings.openrouter_key = getOpenRouterKey();

      const sessionId = parseSessionId(body.session_id);
      const manifest = STORE.manifest(sessionId, body.mode);
      const assembled = recoverRef2VARequest(assembleRefinement(body, { manifest }), body);

      let runtimePlan;
      try {
        runtimePlan = planContext(assembled, { recommended_context: body.context_profile || "standard" }, {
          requestedContext: body.context_profile || "auto",
          requestedKvCache: body.kv_cache || "auto",
          thinking: !!body.thinking,
        });
      } catch (error) {
        return sendError(res, error);
      }

      const requestId = randomUUID();
      STATE.active_request_id = requestId;
      STATE.phase = "generating";
      JOB.controller = new AbortController();

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      try {
        sendEvent({ type: "phase", phase: "generating", request_id: requestId });
        const result = await generate({
          assembled,
          chatCompletion: options.chatCompletion,
          provider,
          modelId: body.model_id,
          settings,
          runtimePlan,
          thinking: !!body.thinking,
          seed: body.seed,
          temperature: 0.4,
          sessionStore: STORE,
          signal: JOB.controller.signal,
          onDelta: (delta) => sendEvent({ type: "delta", content: delta }),
        });
        sendEvent({ type: "complete", result: { request_id: requestId, model_id: body.model_id, thinking: !!body.thinking, ...result } });
      } catch (error) {
        if (error.message?.startsWith("GENERATION_CANCELLED") || error.code === "GENERATION_CANCELLED") {
          sendEvent({ type: "cancelled", request_id: requestId });
        } else {
          sendEvent({ type: "error", error: { code: error.code || "PROVIDER_ERROR", message: error.message, details: error.details } });
        }
      } finally {
        STATE.active_request_id = null;
        STATE.phase = "idle";
        JOB.controller = null;
        res.end();
      }
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/media/upload`, (req, res) => {
    upload.array("file", 12)(req, res, async (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: { code: "MEDIA_TOO_LARGE", message: "A media file cannot exceed 1 GB." } });
        return res.status(400).json({ error: { code: "INVALID_REQUEST", message: err.message } });
      }
      const uploaded = [];
      let sessionId;
      try {
        sessionId = parseSessionId(req.body.session_id);
        const mode = req.body.mode;
        if (!(mode in MODE_LIMITS)) throw new MediaError("INVALID_MODE", "Select a valid mode before uploading media.");
        for (const file of req.files || []) {
          const asset = await STORE.add(sessionId, mode, file.originalname, file.mimetype, file.path);
          uploaded.push(asset);
        }
        if (!uploaded.length) return res.status(400).json({ error: { code: "INVALID_REQUEST", message: "No media files were provided." } });
        res.status(201).json({ session_id: sessionId, assets: uploaded });
      } catch (error) {
        for (const asset of uploaded) await STORE.remove(sessionId, asset.id);
        for (const file of req.files || []) await fs.rm(dirname(file.path), { recursive: true, force: true }).catch(() => {});
        sendError(res, error);
      }
    });
  });

  app.get(`${ROUTE_PREFIX}/media`, (req, res) => {
    try {
      const sessionId = parseSessionId(req.query.session_id);
      res.json({ session_id: sessionId, assets: STORE.list(sessionId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get(`${ROUTE_PREFIX}/media/manifest`, (req, res) => {
    const mode = req.query.mode || "";
    if (!(mode in MODE_LIMITS)) return res.status(400).json({ error: { code: "INVALID_MODE", message: "The selected MiniMax mode is not supported." } });
    try {
      const sessionId = parseSessionId(req.query.session_id);
      res.json(STORE.manifest(sessionId, mode));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get(`${ROUTE_PREFIX}/media/:assetId/content`, async (req, res) => {
    try {
      const sessionId = parseSessionId(req.query.session_id);
      const asset = STORE.get(sessionId, req.params.assetId);
      const kind = req.query.kind || "original";
      let path;
      if (kind === "frame") {
        const index = parseInt(req.query.index || "0", 10);
        path = asset._frames[index].path;
      } else if (kind === "preview") {
        path = asset._preview_path || asset._original_path;
      } else if (kind === "sheet") {
        path = asset._contact_sheet_path;
      } else {
        path = asset._original_path;
      }
      if (req.query.download === "1") {
        const requestedName = req.query.download_name;
        const filename = asset.mode === "Storyboard" && typeof requestedName === "string" && /^[\p{L}\p{N}_.-]{1,200}$/u.test(requestedName) ? requestedName : asset.filename;
        return res.download(path, filename);
      }
      return res.sendFile(path);
    } catch (error) {
      res.status(404).json({ error: { code: "MEDIA_NOT_FOUND", message: "The media asset was not found." } });
    }
  });

  app.delete(`${ROUTE_PREFIX}/media/:assetId`, async (req, res) => {
    try {
      const sessionId = parseSessionId(req.query.session_id);
      await STORE.remove(sessionId, req.params.assetId);
      res.json({ removed: true, assets: STORE.list(sessionId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete(`${ROUTE_PREFIX}/media`, async (req, res) => {
    try {
      const sessionId = parseSessionId(req.query.session_id);
      await STORE.clear(sessionId);
      res.json({ cleared: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/media/reorder`, async (req, res) => {
    try {
      const body = req.body;
      if (!body || !(body.mode in MODE_LIMITS) || !Array.isArray(body.asset_ids)) {
        return res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Mode and ordered asset IDs are required." } });
      }
      const sessionId = parseSessionId(body.session_id);
      const assets = await STORE.reorder(sessionId, body.mode, body.asset_ids);
      res.json({ assets });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get(`${ROUTE_PREFIX}/settings`, (req, res) => {
    const settings = loadSettings();
    settings.openrouter_key = getOpenRouterKey() ? "<redacted>" : null;
    res.json({ settings: redact(settings) });
  });

  app.put(`${ROUTE_PREFIX}/settings`, (req, res) => {
    const { openrouter_key, ...rest } = req.body || {};
    try { res.json({ settings: saveSettings(rest) }); }
    catch (error) { res.status(400).json({ error: { code: "INVALID_SETTINGS", message: error.message } }); }
  });

  app.post(`${ROUTE_PREFIX}/settings/openrouter-key`, (req, res) => {
    const key = req.body?.key;
    if (typeof key !== "string" || !key.trim()) return res.status(400).json({ error: { code: "INVALID_REQUEST", message: "API key must be a non-empty string." } });
    setOpenRouterKey(key.trim());
    res.json({ stored: true });
  });

  app.delete(`${ROUTE_PREFIX}/settings/openrouter-key`, (req, res) => {
    deleteOpenRouterKey();
    res.json({ deleted: true });
  });

  mountStudio(app, options);
  app.get("/krea2.html", (_req, res) => res.redirect("/#krea"));

  app.use(express.static(join(__dirname, "..", "public")));

  return app;
}
