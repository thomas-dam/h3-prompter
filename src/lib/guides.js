import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, "..", "..", "guides");

const SOURCE_REVISION = "bfc8ed0353f5a9733be73e6b2c98ec0948195b86";
const SOURCE_ROOT = `https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/${SOURCE_REVISION}/docs`;

export const GUIDES = {
  base: {
    id: "base",
    title: "MiniMax H3 Video Prompt Writing Guide",
    filename: "VIDEO_PROMPT_WRITING_GUIDE_base_en.md",
    source_sha256: "2cfebc096a6e08370f288d468d90b60f7f9bcb938f94bf090816e910e48e75fc",
  },
  reference: {
    id: "reference",
    title: "MiniMax H3 Reference Prompt Writing Guide",
    filename: "VIDEO_PROMPT_WRITING_GUIDE_ref_en.md",
    source_sha256: "1e574f356716ad55612247ffb7bbccbcdb484ad96599d63c7dca1af186b1fab7",
  },
};

export const MODE_GUIDES = {
  T2VA: "base",
  I2VA: "base",
  FL2VA: "base",
  L2VA: "base",
  Reference: "reference",
};

const _cache = new Map();

function normalized(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/, "") + "\n";
}

export function loadGuide(guideId) {
  if (_cache.has(guideId)) return _cache.get(guideId);
  const spec = GUIDES[guideId];
  if (!spec) throw new Error(`Unknown guide: ${guideId}`);
  const raw = readFileSync(join(GUIDES_DIR, spec.filename), "utf8");
  const content = normalized(raw);
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  if (digest !== spec.source_sha256) {
    throw new Error(`Official guide integrity check failed for ${spec.filename}.`);
  }
  const guide = {
    ...spec,
    source_url: `${SOURCE_ROOT}/${spec.filename}`,
    source_revision: SOURCE_REVISION,
    content_sha256: digest,
    content,
  };
  _cache.set(guideId, guide);
  return guide;
}

export function guideForMode(mode) {
  return loadGuide(MODE_GUIDES[mode]);
}

let _referenceBaseExcerpt = null;

export function referenceBaseExcerpt() {
  if (_referenceBaseExcerpt) return _referenceBaseExcerpt;
  const content = loadGuide("base").content;
  const sections = content.split("\n### ");
  const paragraphLimits = {
    "4.2 Shots and Cuts": 1,
    "4.3 Camera Motion: Motion Type + Amplitude + Speed": 1,
    "4.4 Speakers, Dialogue, and Singing": 2,
    "4.5 On-Screen Text": 1,
    "4.6 overall_soundscape": 1,
    "4.7 non_diegetic_music": 1,
  };
  const selected = [];
  for (const section of sections) {
    const newlineIdx = section.indexOf("\n");
    const title = (newlineIdx === -1 ? section : section.slice(0, newlineIdx)).trim();
    const body = newlineIdx === -1 ? "" : section.slice(newlineIdx + 1);
    const limit = paragraphLimits[title];
    if (limit === undefined) continue;
    const paragraphs = body.split("\n\n").map((p) => p.trim()).filter((p) => p.length > 0);
    const prose = paragraphs.filter((p) => !p.startsWith("```") && !p.startsWith("|") && !p.startsWith("## "));
    selected.push(`### ${title}\n\n` + prose.slice(0, limit).join("\n\n"));
  }
  if (selected.length !== Object.keys(paragraphLimits).length) {
    throw new Error("Could not extract the required shared rules from the official base guide.");
  }
  _referenceBaseExcerpt =
    "# Shared official base-guide rules used by full-reference mode\n\n" +
    selected.join("\n\n") + "\n";
  return _referenceBaseExcerpt;
}

export function guideCatalog() {
  const result = [];
  for (const guideId of Object.keys(GUIDES)) {
    const guide = loadGuide(guideId);
    const { content, ...rest } = guide;
    const modes = Object.keys(MODE_GUIDES).filter((m) => MODE_GUIDES[m] === guideId);
    result.push({ ...rest, modes });
  }
  return result;
}