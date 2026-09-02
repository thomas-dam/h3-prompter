import { promises as fs, constants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { CACHE_ROOT, parseSessionId } from "./media.js";

const idPattern = /^[a-f0-9-]{36}$/;
function checkedId(id) {
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error("Invalid project identifier.");
  return parseSessionId(id);
}
function inside(root, path) {
  const target = resolve(root, path);
  if (!target.startsWith(resolve(root) + sep)) throw new Error("Invalid saved media path.");
  return target;
}
function mapPaths(asset, convert) {
  const copy = structuredClone(asset);
  for (const key of ["_original_path", "_preview_path", "_prepared_path", "_contact_sheet_path"]) {
    if (copy[key]) copy[key] = convert(copy[key]);
  }
  if (copy._frames) copy._frames = copy._frames.map((frame) => ({ ...frame, path: convert(frame.path) }));
  return copy;
}

export class ProjectStore {
  constructor(root = process.env.H3_DATA_DIR || join(homedir(), ".local", "share", "h3-promptwriter", "projects")) {
    this.root = root;
    this.busy = new Set();
  }
  async list() {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    const projects = [];
    for (const entry of entries.filter((e) => e.isDirectory() && idPattern.test(e.name))) {
      try { projects.push(await this.info(entry.name)); } catch { projects.push({ id: entry.name, name: "Unreadable project", damaged: true }); }
    }
    return projects.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }
  async info(id) {
    const info = JSON.parse(await fs.readFile(join(this.root, checkedId(id), "current.json"), "utf8"));
    checkedId(info.snapshot);
    return info;
  }
  async save({ id = randomUUID(), name, state, sessionId, store }) {
    checkedId(id);
    if (this.busy.has(id)) throw new Error("This project is being saved. Try again when it finishes.");
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw new Error("Project name must be 1–120 characters.");
    if (!state || typeof state !== "object" || Array.isArray(state) || JSON.stringify(state).length > 1_000_000) throw new Error("Invalid project state.");
    this.busy.add(id);
    const snapshot = randomUUID();
    const projectDir = join(this.root, id);
    const snapshotDir = join(projectDir, snapshot);
    let committed = false;
    try {
      const previous = await this.info(id).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
      await fs.mkdir(snapshotDir, { recursive: true });
      const assets = [];
      for (const asset of store.assets(sessionId)) {
        const sourceDir = dirname(asset._original_path);
        const destDir = join(snapshotDir, "media", checkedId(asset.id));
        await fs.cp(sourceDir, destDir, { recursive: true, mode: constants.COPYFILE_FICLONE });
        assets.push(mapPaths(asset, (path) => relative(snapshotDir, inside(destDir, relative(sourceDir, path)))));
      }
      await fs.writeFile(join(snapshotDir, "project.json"), JSON.stringify({ schema_version: 1, state, assets }), { mode: 0o600 });
      const info = { id, name: name.trim(), snapshot, updated_at: new Date().toISOString(), created_at: previous?.created_at || new Date().toISOString() };
      const temporary = join(projectDir, `${snapshot}.json.tmp`);
      await fs.writeFile(temporary, JSON.stringify(info), { mode: 0o600 });
      await fs.rename(temporary, join(projectDir, "current.json"));
      committed = true;
      // Prompt revisions live in state; media snapshots only protect atomic saves.
      if (previous) await fs.rm(join(projectDir, previous.snapshot), { recursive: true, force: true }).catch(() => {});
      return info;
    } finally {
      if (!committed) await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
      this.busy.delete(id);
    }
  }
  async open(id, store) {
    const info = await this.info(id);
    if (this.busy.has(id)) throw new Error("This project is being saved. Try again when it finishes.");
    this.busy.add(id);
    const snapshotDir = join(this.root, id, info.snapshot);
    const sessionId = randomUUID();
    const sessionDir = join(CACHE_ROOT, sessionId);
    try {
      const data = JSON.parse(await fs.readFile(join(snapshotDir, "project.json"), "utf8"));
      if (data.schema_version !== 1 || !Array.isArray(data.assets)) throw new Error("Unsupported project format.");
      const restored = [];
      for (const asset of data.assets) {
        const sourceDir = join(snapshotDir, "media", checkedId(asset.id));
        const destDir = join(sessionDir, asset.id);
        await fs.access(inside(snapshotDir, asset._original_path));
        await fs.cp(sourceDir, destDir, { recursive: true, mode: constants.COPYFILE_FICLONE });
        const copy = mapPaths(asset, (path) => inside(sessionDir, relative(join(snapshotDir, "media"), inside(snapshotDir, path))));
        copy.session_id = sessionId;
        restored.push(copy);
      }
      store.sessions.set(sessionId, restored);
      return { project: info, state: data.state, session_id: sessionId, assets: store.list(sessionId) };
    } catch (error) {
      await fs.rm(sessionDir, { recursive: true, force: true });
      throw new Error(`Could not open project; a saved file may be missing or damaged. ${error.message}`);
    } finally { this.busy.delete(id); }
  }
  async remove(id) {
    checkedId(id);
    if (this.busy.has(id)) throw new Error("This project is in use. Try again when it finishes.");
    this.busy.add(id);
    try { await fs.rm(join(this.root, id), { recursive: true, force: true }); }
    finally { this.busy.delete(id); }
  }
}
