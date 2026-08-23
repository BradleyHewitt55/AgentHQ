// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off

import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";

import { USAGE_LIMIT_ADAPTERS } from "./usageAdapters.ts";

import * as NodeFS from "node:fs";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);

function resolve(documentationPath: string): string {
  return NodePath.join(REPO_ROOT, documentationPath);
}

const REQUIRED_DOC_SECTIONS = [
  "## Overview",
  "## Supported Windows",
  "## Data Source",
  "## Authentication Source",
  "## Credential Ownership",
  "## Credential Refresh Behavior",
  "## Request",
  "## Response Mapping",
  "## Remaining-vs-Used Conversion",
  "## Reset-Time Handling",
  "## Error Mapping",
  "## Retry Behavior",
  "## Stale-Data Behavior",
  "## Account Switching",
  "## Platform Notes",
  "## Security Notes",
  "## Manual Validation",
  "## Automated Tests",
  "## Known Limitations",
];

/**
 * Documentation enforcement: a provider cannot quietly gain usage support.
 * Every registered adapter must declare its capabilities and ship the provider
 * document with the full required template. See docs/usage-limits/README.md.
 */
describe("usage-limit adapter registry", () => {
  it("covers every built-in provider", () => {
    const providers = USAGE_LIMIT_ADAPTERS.map((adapter) => adapter.provider).sort();
    expect(providers).toEqual([
      "antigravity",
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
  });

  it("declares capabilities and a documentation path per adapter", () => {
    for (const adapter of USAGE_LIMIT_ADAPTERS) {
      expect(adapter.documentationPath.startsWith("docs/usage-limits/providers/")).toBe(true);
      expect(typeof adapter.refreshStrategy).toBe("string");
      expect(typeof adapter.supportsSession).toBe("boolean");
      expect(typeof adapter.supportsWeekly).toBe("boolean");
      expect(typeof adapter.supportsMonthly).toBe("boolean");
      expect(typeof adapter.supportsBuckets).toBe("boolean");
    }
  });

  it("has an existing, complete documentation file per adapter", () => {
    for (const adapter of USAGE_LIMIT_ADAPTERS) {
      // Tests run from apps/server; resolve the repo-root doc path.
      const docPath = resolve(adapter.documentationPath);
      expect(NodeFS.existsSync(docPath), `missing doc: ${adapter.documentationPath}`).toBe(true);

      const content = NodeFS.readFileSync(docPath, "utf-8");
      for (const section of REQUIRED_DOC_SECTIONS) {
        expect(
          content.includes(section),
          `${adapter.documentationPath} missing section: ${section}`,
        ).toBe(true);
      }
    }
  });
});
