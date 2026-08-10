import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"];
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"];
export const AUDIO_EXTENSIONS = [".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".opus"];
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const REFERENCE_LIMITS = { image: 9, video: 3, audio: 3, total: 12 };
export const REFERENCE_DURATION_TOLERANCE_SECONDS = 15.1;
export const MODE_LIMITS = {
  T2VA: {},
  I2VA: { image: 1 },
  FL2VA: { image: 2 },
  L2VA: { image: 1 },
  Reference: REFERENCE_LIMITS,
};
export const MODE_REQUIREMENTS = {
  T2VA: {},
  I2VA: { image: 1 },
  FL2VA: { image: 2 },
  L2VA: { image: 1 },
  Reference: { visual: 1 },
};

export class MediaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.message = message;
  }
}

export function parseSessionId(value) {
  if (!value) return randomUUID();
  const uuid = String(value).trim();
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!re.test(uuid)) throw new Error("Invalid session ID");
  return uuid.toLowerCase();
}

export function mediaType(filename, contentType) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  const major = (contentType || "").split("/")[0];
  return ["image", "video", "audio"].includes(major) ? major : null;
}

export function validateCapacity(mode, assets, kind) {
  const limits = MODE_LIMITS[mode];
  if (!limits) throw new MediaError("INVALID_MODE", "The selected MiniMax mode is not supported.");
  if (!(kind in limits)) throw new MediaError("UNSUPPORTED_MEDIA", `${mode} does not accept ${kind} files.`);
  const modeAssets = assets.filter((a) => a.mode === mode);
  if (modeAssets.filter((a) => a.type === kind).length >= limits[kind]) {
    throw new MediaError("MEDIA_LIMIT_REACHED", `${mode} has reached its ${kind} limit.`);
  }
  if (mode === "Reference" && modeAssets.length >= REFERENCE_LIMITS.total) {
    throw new MediaError("MEDIA_LIMIT_REACHED", "Reference mode accepts at most 12 files in total.");
  }
}

function validateReferenceDurations(assets, incoming) {
  if (incoming.mode !== "Reference" || (incoming.type !== "video" && incoming.type !== "audio")) return;
  const duration = incoming.duration;
  if (duration === undefined || duration === null || duration < 2 || duration > REFERENCE_DURATION_TOLERANCE_SECONDS) {
    throw new MediaError("UNSUPPORTED_DURATION", "Reference video and audio clips must be 2–15 seconds long.");
  }
}

export class MediaStore {
  constructor() {
    this.sessions = new Map();
  }

  list(sessionId) {
    return (this.sessions.get(sessionId) || []).map((a) => this.public(a));
  }

  assets(sessionId) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
    return this.sessions.get(sessionId);
  }

  get(sessionId, assetId) {
    const asset = (this.sessions.get(sessionId) || []).find((a) => a.id === assetId);
    if (!asset) throw new MediaError("MEDIA_NOT_FOUND", "The media asset was not found in this session.");
    return asset;
  }

  public(asset) {
    const result = {};
    for (const [key, value] of Object.entries(asset)) {
      if (!key.startsWith("_")) result[key] = value;
    }
    result.content_url = `/h3studio/media/${asset.id}/content?session_id=${asset.session_id}`;
    if (asset._preview_path) result.preview_url = `${result.content_url}&kind=preview`;
    if (asset._contact_sheet_path) {
      result.contact_sheet_url = `${result.content_url}&kind=sheet&sample=${asset.sample_index || 0}`;
    }
    result.frames = (asset._frames || []).map((frame, index) => ({
      timestamp: frame.timestamp,
      url: `${result.content_url}&kind=frame&index=${index}&sample=${asset.sample_index || 0}`,
    }));
    return result;
  }

  async add(sessionId, mode, filename, contentType, storedPath) {
    const kind = mediaType(filename, contentType);
    if (!kind) throw new MediaError("UNSUPPORTED_MEDIA", "This file type is not supported.");
    const assets = this.assets(sessionId);
    validateCapacity(mode, assets, kind);
    const assetId = storedPath.split("/").slice(-2, -1)[0];
    const base = {
      id: assetId,
      session_id: sessionId,
      mode,
      type: kind,
      filename: filename.split("/").pop(),
      size: (await fs.stat(storedPath)).size,
      mime_type:
        contentType && contentType !== "application/octet-stream"
          ? contentType
          : guessMime(filename),
      analysis_requested: true,
      _original_path: storedPath,
    };
    try {
      if (kind === "image") Object.assign(base, await processImage(storedPath, storedPath.split("/").slice(0, -1).join("/") + "/"));
      else if (kind === "video") Object.assign(base, await processVideo(storedPath, storedPath.split("/").slice(0, -1).join("/") + "/"));
      else Object.assign(base, await processAudio(storedPath));
      validateReferenceDurations(assets, base);
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError("MEDIA_DECODE_FAILED", `Could not decode ${kind} file: ${error.message}`);
    }
    assets.push(base);
    this._renumber(assets, mode);
    return this.public(base);
  }

  async remove(sessionId, assetId) {
    const asset = this.get(sessionId, assetId);
    const assets = this.sessions.get(sessionId);
    const idx = assets.indexOf(asset);
    if (idx !== -1) assets.splice(idx, 1);
    await fs.rm(asset._original_path.split("/").slice(0, -1).join("/"), { recursive: true, force: true }).catch(() => {});
    this._renumber(assets, asset.mode);
  }

  async clear(sessionId) {
    this.sessions.delete(sessionId);
    await fs.rm(join(CACHE_ROOT, sessionId), { recursive: true, force: true }).catch(() => {});
  }

  async reorder(sessionId, mode, orderedIds) {
    const assets = this.assets(sessionId);
    const modeAssets = assets.filter((a) => a.mode === mode);
    if (orderedIds.length !== modeAssets.length || new Set(orderedIds).size !== modeAssets.size) {
      throw new MediaError("INVALID_MEDIA_ORDER", "The media order does not match the active mode assets.");
    }
    const byId = new Map(modeAssets.map((a) => [a.id, a]));
    const ordered = orderedIds.map((id) => byId.get(id));
    this.sessions.set(
      sessionId,
      assets.map((a) => (a.mode === mode ? ordered.shift() : a)),
    );
    this._renumber(this.sessions.get(sessionId), mode);
    return this.list(sessionId);
  }

  manifest(sessionId, mode) {
    const assets = (this.sessions.get(sessionId) || []).filter((a) => a.mode === mode);
    const violations = [];
    const counts = {
      image: assets.filter((a) => a.type === "image").length,
      video: assets.filter((a) => a.type === "video").length,
      audio: assets.filter((a) => a.type === "audio").length,
    };
    const requirements = MODE_REQUIREMENTS[mode] || {};
    if (requirements.image && counts.image < requirements.image) {
      violations.push({
        code: "REQUIRED_MEDIA_MISSING",
        message: `${mode} requires ${requirements.image} image${requirements.image === 1 ? "" : "s"}.`,
      });
    }
    if (mode === "Reference") {
      if (counts.image + counts.video < requirements.visual) {
        violations.push({
          code: "REFERENCE_REQUIRES_VISUAL",
          message: "Reference mode requires at least one image or video.",
        });
      }
    }
    return {
      session_id: sessionId,
      mode,
      assets: assets.map((a) => this.public(a)),
      counts,
      violations,
      valid: violations.length === 0,
    };
  }

  _renumber(assets, mode) {
    const perType = { image: 0, video: 0, audio: 0 };
    for (const asset of assets.filter((a) => a.mode === mode)) {
      perType[asset.type]++;
      if (mode === "Reference") {
        const names = { image: "Picture", video: "Video", audio: "Audio" };
        asset.reference = `<${names[asset.type]} ${perType[asset.type]}>`;
      } else if (mode === "FL2VA") {
        asset.reference = perType.image === 1 ? "First frame" : "Last frame";
      } else if (mode === "I2VA") {
        asset.reference = "Start image";
      } else if (mode === "L2VA") {
        asset.reference = "Last frame";
      }
    }
  }
}

function guessMime(filename) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const map = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".webm": "video/webm", ".avi": "video/x-msvideo", ".m4v": "video/x-m4v",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac",
    ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".aac": "audio/aac", ".opus": "audio/opus",
  };
  return map[ext] || "application/octet-stream";
}

export const CACHE_ROOT = join(tmpdir(), "h3-promptwriter");

export const STORE = new MediaStore();

export async function processImage(source, targetDir) {
  const previewPath = join(targetDir, "preview.jpg");
  const preparedPath = join(targetDir, "prepared.jpg");
  const image = sharp(source, { failOn: "none" }).rotate();
  const meta = await image.metadata();
  await image.clone().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92, mozjpeg: true }).toFile(preparedPath);
  await image.clone().resize(640, 640, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 84, mozjpeg: true }).toFile(previewPath);
  return {
    width: meta.width,
    height: meta.height,
    _prepared_path: preparedPath,
    _preview_path: previewPath,
  };
}

function ffprobeJson(source) {
  return new Promise((resolve, reject) => {
    execFile("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", source], (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

async function avMetadata(source) {
  const info = await ffprobeJson(source);
  const video = (info.streams || []).find((s) => s.codec_type === "video");
  const audio = (info.streams || []).find((s) => s.codec_type === "audio");
  let duration = parseFloat(info.format?.duration) || null;
  if (duration === null && video?.duration) duration = parseFloat(video.duration);
  return {
    duration: duration !== null ? Math.round(duration * 1000) / 1000 : null,
    width: video ? parseInt(video.width, 10) : null,
    height: video ? parseInt(video.height, 10) : null,
    has_audio: !!audio,
    sample_rate: audio ? parseInt(audio.sample_rate, 10) : null,
    channels: audio ? parseInt(audio.channels, 10) : null,
  };
}

function extractFrame(source, timestamp, targetPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-ss", String(timestamp), "-i", source, "-frames:v", "1", "-vf", "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease", "-q:v", "3", targetPath],
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

export async function processVideo(source, targetDir, { frameCountMode = "auto", includeEndpoints = true, sampleIndex = 0 } = {}) {
  const metadata = await avMetadata(source);
  const duration = metadata.duration;
  if (!duration || duration <= 0) throw new MediaError("MEDIA_DECODE_FAILED", "Video duration could not be determined.");
  const count = frameCountMode === "auto" ? 8 : parseInt(frameCountMode, 10);
  const margin = Math.min(0.25, duration * 0.03);
  const span = duration - 2 * margin;
  const offsets = [0.0, -0.22, 0.22, -0.11, 0.11];
  const offset = offsets[sampleIndex % offsets.length];
  let positions;
  if (includeEndpoints) {
    const middle = [];
    for (let i = 1; i < count - 1; i++) {
      middle.push(Math.min(0.999, Math.max(0.001, i / (count - 1) + offset / (count - 1))));
    }
    positions = [0.0, ...middle, 1.0];
  } else {
    positions = [];
    for (let i = 0; i < count; i++) positions.push(Math.min(0.999, Math.max(0.001, (i + 0.5 + offset) / count)));
  }
  const times = positions.map((p) => margin + span * p);

  const frames = [];
  for (let i = 0; i < times.length; i++) {
    const framePath = join(targetDir, `frame_${String(i).padStart(2, "0")}.jpg`);
    try {
      await extractFrame(source, times[i], framePath);
      frames.push({ timestamp: Math.round(times[i] * 1000) / 1000, path: framePath });
    } catch { /* skip failed frame */ }
  }
  if (frames.length === 0) throw new MediaError("MEDIA_DECODE_FAILED", "No video frames could be sampled.");

  const contactSheetPath = join(targetDir, "motion_contact_sheet.jpg");
  await buildContactSheet(frames, contactSheetPath);

  metadata._frames = frames;
  metadata._contact_sheet_path = contactSheetPath;
  metadata._preview_path = frames[0].path;
  metadata.sampling = "uniform";
  metadata.frame_count_mode = frameCountMode;
  metadata.frame_count = count;
  metadata.include_endpoints = includeEndpoints;
  metadata.sample_index = sampleIndex;
  return metadata;
}

async function buildContactSheet(frames, target) {
  const columns = frames.length <= 6 ? 3 : 4;
  const rows = Math.ceil(frames.length / columns);
  const cellWidth = 384;
  const firstMeta = await sharp(frames[0].path).metadata();
  const srcW = firstMeta.width || 1;
  const srcH = firstMeta.height || 1;
  const cellHeight = Math.max(216, Math.min(512, Math.round(cellWidth * srcH / Math.max(srcW, 1))));
  const gutterHeight = 28;
  const cellTotalHeight = cellHeight + gutterHeight;

  const composites = [];
  for (let i = 0; i < frames.length; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const resized = await sharp(frames[i].path)
      .resize(cellWidth, cellHeight, { fit: "contain", background: "#101216" })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    const left = col * cellWidth + Math.floor((cellWidth - (await sharp(resized).metadata()).width) / 2);
    const cellTop = row * cellTotalHeight;
    const top = cellTop + gutterHeight + Math.floor((cellHeight - (await sharp(resized).metadata()).height) / 2);
    composites.push({ input: resized, left, top });
  }

  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellTotalHeight,
      channels: 3,
      background: "#101216",
    },
  })
    .composite(composites)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(target);
}

export async function processAudio(source) {
  const metadata = await avMetadata(source);
  if (metadata.duration === null) throw new MediaError("MEDIA_DECODE_FAILED", "Audio duration could not be determined.");
  delete metadata.width;
  delete metadata.height;
  delete metadata.has_audio;
  return metadata;
}

export function resetCache() {
  return fs.rm(CACHE_ROOT, { recursive: true, force: true }).then(() => fs.mkdir(CACHE_ROOT, { recursive: true }));
}
