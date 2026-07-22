import { describe, expect, it } from "@effect/vitest";

import {
  ANTIGRAVITY_MODEL_NAMES,
  AntigravityOutputSanitizer,
  buildAntigravityArgs,
  buildAntigravityPrompt,
  DEFAULT_ANTIGRAVITY_MODEL,
  isAntigravityCommandWithinBudget,
  resolveCliModel,
  runtimeModeToAntigravityArgs,
  sanitizeCliOutput,
} from "./antigravityLaunch.ts";

describe("resolveCliModel", () => {
  it("appends the catalog effort to a bare model name", () => {
    expect(resolveCliModel("Gemini 3.1 Pro")).toBe("Gemini 3.1 Pro (Low)");
    expect(resolveCliModel("Gemini 3.6 Flash")).toBe("Gemini 3.6 Flash (Medium)");
  });

  it("uses Thinking for the Claude models the CLI only accepts that way", () => {
    expect(resolveCliModel("Claude Sonnet 4.6")).toBe("Claude Sonnet 4.6 (Thinking)");
    expect(resolveCliModel("Claude Opus 4.6")).toBe("Claude Opus 4.6 (Thinking)");
  });

  it("leaves an already-suffixed model untouched", () => {
    expect(resolveCliModel("Gemini 3.6 Flash (High)")).toBe("Gemini 3.6 Flash (High)");
  });

  it("defaults an unknown model to Medium", () => {
    expect(resolveCliModel("Some New Model")).toBe("Some New Model (Medium)");
  });

  it("does not mistake an unrelated parenthesised suffix for an effort", () => {
    expect(resolveCliModel("Foo (Preview)")).toBe("Foo (Preview) (Medium)");
  });
});

describe("runtimeModeToAntigravityArgs", () => {
  it("only bypasses permissions for full access", () => {
    expect(runtimeModeToAntigravityArgs("full-access")).toEqual(["--dangerously-skip-permissions"]);
    expect(runtimeModeToAntigravityArgs("auto-accept-edits")).toEqual([
      "--mode",
      "accept-edits",
      "--sandbox",
    ]);
    expect(runtimeModeToAntigravityArgs("approval-required")).toEqual([
      "--mode",
      "plan",
      "--sandbox",
    ]);
  });
});

describe("buildAntigravityArgs", () => {
  it("starts an isolated project on every turn", () => {
    const args = buildAntigravityArgs({
      runtimeMode: "full-access",
      model: DEFAULT_ANTIGRAVITY_MODEL,
      prompt: "hello",
    });
    expect(args[0]).toBe("--new-project");
    expect(args).not.toContain("--continue");
  });

  it("keeps the prompt in a single --print=value argument", () => {
    const args = buildAntigravityArgs({
      runtimeMode: "approval-required",
      model: "Gemini 3.1 Pro",
      prompt: "--not-a-flag",
    });
    expect(args).toEqual([
      "--new-project",
      "--mode",
      "plan",
      "--sandbox",
      "--model",
      "Gemini 3.1 Pro (Low)",
      "--print=--not-a-flag",
    ]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("defaults to the first advertised model", () => {
    expect(DEFAULT_ANTIGRAVITY_MODEL).toBe(ANTIGRAVITY_MODEL_NAMES[0]);
  });

  it("conservatively rejects commands whose shell escaping can exceed Windows limits", () => {
    expect(isAntigravityCommandWithinBudget("agy.cmd", ["--print=short"])).toBe(true);
    expect(isAntigravityCommandWithinBudget("agy.cmd", [`--print=${'"'.repeat(12_000)}`])).toBe(
      false,
    );
  });
});

describe("buildAntigravityPrompt", () => {
  it("replays prior turns without relying on process-global --continue", () => {
    expect(buildAntigravityPrompt([{ user: "first", assistant: "answer" }], "second")).toBe(
      "Previous conversation:\n\nUser:\nfirst\n\nAssistant:\nanswer\n\nCurrent user message:\nsecond",
    );
  });
});

describe("sanitizeCliOutput", () => {
  it("strips ANSI colour codes", () => {
    const escape = String.fromCharCode(0x1b);
    expect(sanitizeCliOutput(`${escape}[32mgreen${escape}[0m`)).toBe("green");
  });

  it("keeps only the last frame of a carriage-return redraw", () => {
    expect(sanitizeCliOutput("thinking...\rdone\nnext")).toBe("done\nnext");
  });

  it("handles ANSI escapes and redraws split across chunks", () => {
    const escape = String.fromCharCode(0x1b);
    const sanitizer = new AntigravityOutputSanitizer();
    expect(sanitizer.push(`thinking\rdo${escape}[3`)).toBe("");
    expect(sanitizer.push("2mne\nnext")).toBe("done\n");
    expect(sanitizer.finish()).toBe("next");
  });
});
