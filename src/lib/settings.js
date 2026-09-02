import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const SETTINGS_PATH = process.env.H3_SETTINGS_PATH || join(homedir(), ".config", "h3-promptwriter", "settings.json");

const DEFAULTS = {
  provider: "lmstudio",
  lmstudio_base_url: "http://127.0.0.1:1234/v1",
  lmstudio_model_id: "",
  lmstudio_context_profile: "auto",
  lmstudio_kv_cache: "auto",
  lmstudio_thinking: false,
  openrouter_model_id: "",
  openrouter_context_profile: "auto",
  openrouter_kv_cache: "auto",
  openrouter_thinking: false,
};

function ensureDir() {
  const dir = dirname(SETTINGS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadSettings() {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(partial) {
  if (partial.lmstudio_base_url !== undefined) partial.lmstudio_base_url = localBaseUrl(partial);
  const current = loadSettings();
  const next = { ...current, ...partial };
  ensureDir();
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return redact(next);
}

export function localBaseUrl(settings) {
  const url = new URL(settings.lmstudio_base_url || DEFAULTS.lmstudio_base_url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("LM Studio requires an HTTP(S) base URL without credentials, query, or fragment.");
  }
  return url.href.replace(/\/$/, "");
}

export function redact(settings) {
  return { ...settings, openrouter_key: settings.openrouter_key ? "<redacted>" : null };
}

const KEYCHAIN_SERVICE = "h3-promptwriter";
const KEYCHAIN_ACCOUNT = "openrouter";

export function getOpenRouterKey() {
  try {
    const result = execFileSync("security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", KEYCHAIN_ACCOUNT,
      "-w",
    ], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return result.trim() || null;
  } catch {
    return null;
  }
}

export function setOpenRouterKey(key) {
  try {
    execFileSync("security", [
      "delete-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", KEYCHAIN_ACCOUNT,
    ], { stdio: ["pipe", "pipe", "pipe"] });
  } catch { /* ignore if not found */ }
  if (key) {
    execFileSync("security", [
      "add-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", KEYCHAIN_ACCOUNT,
      "-w", key,
    ], { stdio: ["pipe", "pipe", "pipe"] });
  }
  return true;
}

export function deleteOpenRouterKey() {
  try {
    execFileSync("security", [
      "delete-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", KEYCHAIN_ACCOUNT,
    ], { stdio: ["pipe", "pipe", "pipe"] });
  } catch { /* ignore */ }
  return true;
}
