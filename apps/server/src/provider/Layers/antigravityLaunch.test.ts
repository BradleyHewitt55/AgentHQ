import { describe, expect, it } from "@effect/vitest";

import {
  ANTIGRAVITY_MODEL_NAMES,
  buildAntigravityArgs,
  DEFAULT_ANTIGRAVITY_MODEL,
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
  it("starts a project on the first turn and continues afterwards", () => {
    const first = buildAntigravityArgs({
      runtimeMode: "full-access",
      model: DEFAULT_ANTIGRAVITY_MODEL,
      prompt: "hello",
      resumeConversation: false,
    });
    expect(first[0]).toBe("--new-project");
    const second = buildAntigravityArgs({
      runtimeMode: "full-access",
      model: DEFAULT_ANTIGRAVITY_MODEL,
      prompt: "hello",
      resumeConversation: true,
    });
    expect(second[0]).toBe("--continue");
  });

  it("keeps the prompt in a single --print=value argument", () => {
    const args = buildAntigravityArgs({
      runtimeMode: "approval-required",
      model: "Gemini 3.1 Pro",
      prompt: "--not-a-flag",
      resumeConversation: false,
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
});

describe("sanitizeCliOutput", () => {
  it("strips ANSI colour codes", () => {
    const escape = String.fromCharCode(0x1b);
    expect(sanitizeCliOutput(`${escape}[32mgreen${escape}[0m`)).toBe("green");
  });

  it("keeps only the last frame of a carriage-return redraw", () => {
    expect(sanitizeCliOutput("thinking...\rdone\nnext")).toBe("done\nnext");
  });
});
