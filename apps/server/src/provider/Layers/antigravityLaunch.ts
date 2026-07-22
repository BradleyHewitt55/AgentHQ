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
// Keep well below CreateProcess' 32,767 UTF-16-code-unit ceiling. The reserve
// covers the executable, model and permission flags plus Windows quoting and
// cmd.exe escaping when PATH resolution requires shell mode.
export const ANTIGRAVITY_MAX_PROMPT_CHARS = 8_000;
export const ANTIGRAVITY_MAX_WINDOWS_COMMAND_CHARS = 30_000;

export interface AntigravityConversationExchange {
  readonly user: string;
  readonly assistant: string;
}

const formatExchange = (exchange: AntigravityConversationExchange) =>
  `User:\n${exchange.user}\n\nAssistant:\n${exchange.assistant}`;

/**
 * `agy --continue` is process-global, so it can attach one T3 thread to a
 * different thread's most recent conversation. Replay a bounded transcript
 * into a new CLI project instead. Newest exchanges win when the budget fills.
 */
export function buildAntigravityPrompt(
  history: ReadonlyArray<AntigravityConversationExchange>,
  currentPrompt: string,
): string {
  const current = `Current user message:\n${currentPrompt}`;
  const selected: string[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = [formatExchange(history[index]!), ...selected];
    const replay = `Previous conversation:\n\n${candidate.join("\n\n")}\n\n${current}`;
    if (replay.length > ANTIGRAVITY_MAX_PROMPT_CHARS) break;
    selected.unshift(candidate[0]!);
  }
  return selected.length === 0
    ? currentPrompt
    : `Previous conversation:\n\n${selected.join("\n\n")}\n\n${current}`;
}

export interface AntigravityLaunchInput {
  readonly runtimeMode: RuntimeMode;
  readonly model: string;
  readonly prompt: string;
}

export function buildAntigravityArgs(input: AntigravityLaunchInput): ReadonlyArray<string> {
  return [
    "--new-project",
    ...runtimeModeToAntigravityArgs(input.runtimeMode),
    "--model",
    resolveCliModel(input.model),
    // `--flag=value` form: the CLI has no `--` terminator, so a prompt starting
    // with `-` would otherwise be re-parsed as a flag.
    `--print=${input.prompt}`,
  ];
}

/**
 * `resolveSpawnCommand` can expand each dynamic character when quoting for
 * cmd.exe. Three code units per input code unit is a conservative upper bound;
 * reject before spawning if even that bound reaches CreateProcess' ceiling.
 */
export function isAntigravityCommandWithinBudget(
  command: string,
  args: ReadonlyArray<string>,
): boolean {
  const rawLength = command.length + args.reduce((length, arg) => length + arg.length, 0);
  const separatorsAndQuotes = args.length * 3;
  return rawLength * 3 + separatorsAndQuotes <= ANTIGRAVITY_MAX_WINDOWS_COMMAND_CHARS;
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

/**
 * Buffers only the unfinished output line so ANSI escapes and carriage-return
 * redraws split across process chunks are sanitized as one unit.
 */
export class AntigravityOutputSanitizer {
  readonly #pending: string[] = [];
  #line = "";

  push(chunk: string): string {
    const lines = `${this.#line}${chunk}`.split("\n");
    this.#line = lines.pop() ?? "";
    for (const line of lines) this.#pending.push(`${sanitizeCliOutput(line)}\n`);
    return this.#drain();
  }

  finish(): string {
    if (this.#line) this.#pending.push(sanitizeCliOutput(this.#line));
    this.#line = "";
    return this.#drain();
  }

  #drain(): string {
    const output = this.#pending.join("");
    this.#pending.length = 0;
    return output;
  }
}
