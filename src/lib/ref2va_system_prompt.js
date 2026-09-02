// The Ref2VA system prompt lives in minimax-h3-ref2va-system-prompt.md so the
// documented prompt and the one the app sends can never drift apart. The file
// wraps the prompt in a single fenced block; only that block is sent.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REF2VA_SYSTEM_PROMPT_FILE = join(__dirname, "..", "..", "minimax-h3-ref2va-system-prompt.md");

// The document allows one clarifying question. This app generates in a single
// non-conversational pass, so the request has to be answered as written.
const APP_CONTEXT = `This request is generated in one non-conversational pass: never ask a clarifying question. When something is underspecified, choose the most reasonable reading of the brief and the assigned reference roles, and output the finished prompt only.`;

function extractPrompt(markdown) {
  const match = markdown.replace(/\r\n/g, "\n").match(/^```[^\n]*\n([\s\S]*?)\n```/m);
  if (!match) throw new Error(`No fenced system prompt found in ${REF2VA_SYSTEM_PROMPT_FILE}`);
  const prompt = match[1].trim();
  if (!prompt) throw new Error(`The fenced system prompt in ${REF2VA_SYSTEM_PROMPT_FILE} is empty.`);
  return `${prompt}\n\n${APP_CONTEXT}`;
}

export function loadRef2VASystemPrompt(file = REF2VA_SYSTEM_PROMPT_FILE) {
  return extractPrompt(readFileSync(file, "utf8"));
}

export const REF2VA_SYSTEM_PROMPT = loadRef2VASystemPrompt();
