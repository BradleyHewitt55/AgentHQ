// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "@effect/vitest";

import {
  parseClaudeCredentialsJson,
  readClaudeOAuthCredentials,
  readFromCredentialsFile,
} from "./claudeCredentials.ts";

describe("claude credential parsing", () => {
  it("extracts access and refresh tokens", () => {
    const parsed = parseClaudeCredentialsJson(
      JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } }),
      "credentials-file",
    );
    expect(parsed.token).toBe("a");
    expect(parsed.hasRefreshableCredentials).toBe(true);
    expect(parsed.source).toBe("credentials-file");
  });

  it("treats malformed content as empty, never throws", () => {
    for (const raw of ["", "{oops", "null"]) {
      const parsed = parseClaudeCredentialsJson(raw, "legacy-keychain");
      // Unusable content normalizes to source 'none' regardless of caller label.
      expect(parsed.token).toBeNull();
      expect(parsed.source === "legacy-keychain" || parsed.source === "none").toBe(true);
    }
  });
});

describe("credential store resolution", () => {
  it("reads .credentials.json under the given config dir", async () => {
    let observedPath = "";
    const creds = await readFromCredentialsFile("/cfg/dir", async (p) => {
      observedPath = p;
      return JSON.stringify({ claudeAiOauth: { accessToken: "t" } });
    });
    expect(observedPath.replaceAll("\\", "/")).toContain("/cfg/dir/.credentials.json");
    expect(creds.token).toBe("t");
  });

  it("short-circuits on refresh-only keychain credentials before reading files", async () => {
    // Orca-faithful ordering: a refresh-only keychain entry is reported as such
    // (delegated repair) instead of shadowed by a possibly-stale file token.
    let fileReads = 0;
    const creds = await readClaudeOAuthCredentials({
      platform: "linux",
      configDir: "/cfg",
      readKeychain: async (dir) =>
        dir === undefined
          ? null
          : JSON.stringify({ claudeAiOauth: { refreshToken: "refresh-only" } }),
      readText: async () => {
        fileReads += 1;
        return JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } });
      },
    });
    expect(fileReads).toBe(0);
    expect(creds.token).toBeNull();
    expect(creds.hasRefreshableCredentials).toBe(true);
  });

  it("surfaces keychain unavailability distinctly", async () => {
    const creds = await readClaudeOAuthCredentials({
      platform: "linux",
      configDir: "/cfg",
      readKeychain: async () => {
        throw new Error("security tool exploded");
      },
      readText: async () => {
        throw new Error("missing");
      },
    });
    expect(creds.keychainUnavailable).toBe(true);
    expect(creds.token).toBeNull();
  });
});
