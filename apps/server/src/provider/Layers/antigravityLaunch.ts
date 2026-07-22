import type { RuntimeMode } from "@t3tools/contracts";

/**
 * The reasoning-effort vocabulary the `agy` CLI accepts as a `--model` suffix.
 * Anything else is rejected with "invalid --model".
 */
export const ANTIGRAVITY_EFFORTS = ["High", "Medium", "Low", "Thinking"] as const;
export type AntigravityEffort = (typeof ANTIGRAVITY_EFFORTS)[number];

/**
 * The single source of truth for the built-in catalog: the driver lists the
 * names, the adapter appends the effort. Keeping both here means a new model
 * cannot silently fall back to `Medium` in one file and be advertised in the
 * other.
 *
 * `--model` takes the display-name form ("Gemini 3.6 Flash (Medium)"), not the
 * slug form that `agy models` prints.
 */
export const ANTIGRAVITY_MODELS: ReadonlyArray<{
  readonly name: string;
  readonly effort: AntigravityEffort;
}> = [
  { name: "Gemini 3.6 Flash", effort: "Medium" },
  { name: "Gemini 3.5 Flash", effort: "Medium" },
  { name: "Gemini 3.1 Pro", effort: "Low" },
  { name: "Claude Sonnet 4.6", effort: "Thinking" },
  { name: "Claude Opus 4.6", effort: "Thinking" },
  { name: "GPT-OSS 120B", effort: "Medium" },
];

export const ANTIGRAVITY_MODEL_NAMES: ReadonlyArray<string> = ANTIGRAVITY_MODELS.map(
  (model) => model.name,
);

export const DEFAULT_ANTIGRAVITY_MODEL = ANTIGRAVITY_MODEL_NAMES[0]!;

const DEFAULT_EFFORT: AntigravityEffort = "Medium";

const EFFORT_BY_MODEL = new Map<string, AntigravityEffort>(
  ANTIGRAVITY_MODELS.map((model) => [model.name, model.effort]),
);

const EFFORT_SUFFIX_PATTERN = new RegExp(`\\((?:${ANTIGRAVITY_EFFORTS.join("|")})\\)\\s*$`, "u");

/**
 * The CLI only accepts `--model` values carrying an explicit effort suffix. The
 * suffix is the only effort mechanism used here: `--effort` is a separate flag
 * that defaults to empty, and mixing the two gives two places to disagree.
 */
export function resolveCliModel(model: string): string {
  const trimmed = model.trim();
  if (EFFORT_SUFFIX_PATTERN.test(trimmed)) return trimmed;
  return `${trimmed} (${EFFORT_BY_MODEL.get(trimmed) ?? DEFAULT_EFFORT})`;
}

/**
 * Maps the thread's runtime mode onto the CLI's permission flags. Print mode
 * cannot prompt for approvals, so `approval-required` becomes plan mode inside
 * the sandbox — read and reason, never act.
 */
export function runtimeModeToAntigravityArgs(mode: RuntimeMode): ReadonlyArray<string> {
  switch (mode) {
    case "approval-required":
      return ["--mode", "plan", "--sandbox"];
    case "auto-accept-edits":
      return ["--mode", "accept-edits", "--sandbox"];
    case "full-access":
      return ["--dangerously-skip-permissions"];
  }
}

/**
 * Windows caps a command line at 32,767 characters, and the CLI accepts the
 * prompt only as an argv element — there is no stdin input, no `@file` syntax
 * and no positional prompt. Oversized prompts are rejected up front rather than
 * dying at spawn with an opaque OS error.
 */
export const ANTIGRAVITY_MAX_PROMPT_CHARS = 24_000;

export interface AntigravityLaunchInput {
  readonly runtimeMode: RuntimeMode;
  readonly model: string;
  readonly prompt: string;
  /** False on the first turn of a session, true afterwards. */
  readonly resumeConversation: boolean;
}

export function buildAntigravityArgs(input: AntigravityLaunchInput): ReadonlyArray<string> {
  return [
    // `--continue` resumes the most recent conversation, which is only
    // unambiguous because turns of a session are serialized and each turn is
    // its own process. The CLI prints no conversation ID, so `--conversation`
    // cannot be targeted explicitly.
    ...(input.resumeConversation ? ["--continue"] : ["--new-project"]),
    ...runtimeModeToAntigravityArgs(input.runtimeMode),
    "--model",
    resolveCliModel(input.model),
    // `--flag=value` form: the CLI has no `--` terminator, so a prompt starting
    // with `-` would otherwise be re-parsed as a flag.
    `--print=${input.prompt}`,
  ];
}

const ESCAPE = String.fromCharCode(0x1b);
const ANSI_PATTERN = new RegExp(`${ESCAPE}(?:\\[[0-9;?]*[ -/]*[@-~]|[@-Z\\\\-_])`, "gu");

/**
 * Strips the ANSI colour codes and carriage-return progress redraws the CLI
 * writes to stdout so control characters do not land verbatim in the assistant
 * message.
 */
export function sanitizeCliOutput(value: string): string {
  return value
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}
