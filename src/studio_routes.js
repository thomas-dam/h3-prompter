import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { STORE, CACHE_ROOT, parseSessionId } from "./lib/media.js";
import { ProjectStore } from "./lib/projects.js";
import { JOB, streamJob } from "./lib/jobs.js";
import { prepareClip } from "./lib/video.js";
import { analyzeClip, videoPrompt, kreaPrompt } from "./lib/studio_models.js";
import { mountStoryboard } from "./storyboard_routes.js";

export function mountStudio(app, { chatCompletion, projects = new ProjectStore() } = {}) {
  mountStoryboard(app, { chatCompletion });
  const route = (work) => async (req, res) => {
    try { await work(req, res); }
    catch (error) { res.status(error.code === "ENOENT" ? 404 : 400).json({ error: { code: error.code || "INVALID_REQUEST", message: error.message } }); }
  };
  const session = (req) => {
    if (!req.body?.session_id) throw new Error("A session ID is required.");
    return parseSessionId(req.body.session_id);
  };
  const clipFor = (req) => {
    const clip = STORE.get(session(req), req.body.clip_id);
    if (clip.mode !== "Video" || clip.type !== "video") throw new Error("Select a prepared clip.");
    return clip;
  };
  app.post("/h3studio/clips/source", route(async (req, res) => {
    if (JOB.active_request_id) throw new Error("Wait for the active operation before replacing its source.");
    const sessionId = session(req);
    const uploadSession = parseSessionId(req.body.upload_session_id);
    if (uploadSession === sessionId) throw new Error("Use a separate upload session for source replacement.");
    const source = STORE.get(uploadSession, req.body.asset_id);
    if (source.mode !== "VideoSource" || source.type !== "video") throw new Error("A source video is required.");
    const previous = STORE.assets(sessionId).filter((a) => a.mode === "VideoSource" || (a.mode === "Video" && a.type === "video"));
    const targetDir = join(CACHE_ROOT, sessionId, source.id);
    await fs.mkdir(dirname(targetDir), { recursive: true });
    await fs.rename(dirname(source._original_path), targetDir);
    source._original_path = join(targetDir, basename(source._original_path));
    STORE.sessions.set(uploadSession, STORE.assets(uploadSession).filter((a) => a.id !== source.id));
    source.session_id = sessionId;
    STORE.assets(sessionId).push(source);
    for (const asset of previous) await STORE.remove(sessionId, asset.id);
    res.json({ source: STORE.public(source) });
  }));
  app.post("/h3studio/clips/prepare", route(async (req, res) => {
    const sessionId = session(req);
    const source = STORE.get(sessionId, req.body.source_id);
    await streamJob(req, res, (context) => prepareClip({ source, start: req.body.start, end: req.body.end, store: STORE, sessionId, ...context }));
  }));
  app.post("/h3studio/clips/analyze", route(async (req, res) => {
    const clip = clipFor(req);
    await streamJob(req, res, (context) => analyzeClip(req.body, clip, { ...context, chatCompletion }));
  }));
  app.post("/h3studio/video/generate", route(async (req, res) => {
    const clip = clipFor(req);
    await streamJob(req, res, (context) => videoPrompt(req.body, clip, STORE, { ...context, chatCompletion }));
  }));
  for (const path of ["/kreastudio/generate", "/kreastudio/refine"]) app.post(path, route(async (req, res) => {
    session(req);
    await streamJob(req, res, (context) => kreaPrompt(req.body, STORE, { ...context, chatCompletion }));
  }));
  app.get("/h3studio/projects", route(async (_req, res) => res.json({ projects: await projects.list() })));
  app.post("/h3studio/projects", route(async (req, res) => {
    if (JOB.active_request_id) throw new Error("Wait for the current operation before saving a project.");
    res.json({ project: await projects.save({ ...req.body, sessionId: session(req), store: STORE }) });
  }));
  app.post("/h3studio/projects/:id/open", route(async (req, res) => {
    if (JOB.active_request_id) throw new Error("Wait for the current operation before opening a project.");
    res.json(await projects.open(req.params.id, STORE));
  }));
  app.delete("/h3studio/projects/:id", route(async (req, res) => { await projects.remove(req.params.id); res.json({ deleted: true }); }));
}
