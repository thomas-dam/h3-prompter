import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CACHE_ROOT, avMetadata, buildContactSheet } from "./media.js";

export function runMedia(command, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
export function validateRange(start, end, duration) {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || end > duration + 0.001 || end - start < 2 || end - start > 15) {
    throw new Error("Select a 2–15 second segment within the source video.");
  }
}
export async function prepareClip({ source, start, end, store, sessionId, signal, progress }) {
  if (source.mode !== "VideoSource") throw new Error("Select a source video first.");
  validateRange(start, end, source.duration);
  const id = randomUUID();
  const dir = join(CACHE_ROOT, sessionId, id);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, "clip.mp4");
  try {
    progress("trimming", "Preparing the exact clip used for both analysis and export…");
    await runMedia("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", String(start), "-i", source._original_path, "-t", String(end - start),
      "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=trunc(iw*sar/2)*2:ih,setsar=1,pad=ceil(iw/2)*2:ceil(ih/2)*2",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", path], signal);
    signal.throwIfAborted();
    const metadata = await avMetadata(path);
    if (!metadata.duration || metadata.duration > 15.1) throw new Error("The prepared clip has an invalid duration.");
    progress("sampling", "Extracting timestamped frames…");
    await runMedia("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", path, "-vf", "fps=5:start_time=0:round=up,scale=768:768:force_original_aspect_ratio=decrease", "-q:v", "3", join(dir, "sample_%03d.jpg")], signal);
    const names = (await fs.readdir(dir)).filter((n) => /^sample_\d+\.jpg$/.test(n)).sort();
    const frames = names.map((name, i) => ({ timestamp: Math.round(i * 200) / 1000, path: join(dir, name) })).filter((f) => f.timestamp < metadata.duration);
    if (!frames.length || frames.length > 100) throw new Error("Could not sample the selected clip within its frame budget.");
    const sheet = join(dir, "motion_contact_sheet.jpg");
    const overview = Array.from({ length: Math.min(8, frames.length) }, (_, i) => frames[Math.round(i * (frames.length - 1) / 7)]).filter(Boolean);
    await buildContactSheet(overview, sheet);
    signal.throwIfAborted();
    const old = store.assets(sessionId).filter((a) => a.mode === "Video" && a.type === "video");
    const clip = { id, session_id: sessionId, mode: "Video", type: "video", filename: `${source.filename.replace(/\.[^.]+$/, "")}_clip.mp4`,
      mime_type: "video/mp4", size: (await fs.stat(path)).size, ...metadata, source_id: source.id, range_start: start, range_end: end,
      analysis_requested: true, reference: "<Video 1>", _original_path: path, _preview_path: frames[0].path, _contact_sheet_path: sheet, _frames: frames };
    store.assets(sessionId).push(clip);
    for (const previous of old) await store.remove(sessionId, previous.id);
    store._renumber(store.assets(sessionId), "Video");
    return store.public(clip);
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

export async function extraFrames(clip, times, signal) {
  const frames = [];
  for (const time of times) {
    signal.throwIfAborted();
    const path = join(CACHE_ROOT, clip.session_id, clip.id, `detail_${Math.round(time * 1000)}.jpg`);
    await runMedia("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", String(time), "-i", clip._original_path, "-frames:v", "1", "-vf", "scale=768:768:force_original_aspect_ratio=decrease", "-q:v", "3", path], signal);
    frames.push({ timestamp: time, path });
  }
  return frames;
}
