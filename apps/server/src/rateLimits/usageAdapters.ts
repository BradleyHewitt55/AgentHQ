// @effect-diagnostics globalDate:off
import type { ProviderUsageLimits } from "@t3tools/contracts";

import { fetchClaudeRateLimits, type FetchClaudeRateLimitsOptions } from "./claudeFetcher.ts";
import { fetchCodexRateLimits, type FetchCodexRateLimitsOptions } from "./codexFetcher.ts";
import {
  fetchAntigravityRateLimits,
  type FetchGeminiRateLimitsOptions,
} from "./geminiUsageFetcher.ts";
import type { GrokAuthReadResult } from "./grokAuth.ts";
import { fetchGrokRateLimits } from "./grokFetcher.ts";

/**
 * Explicit per-provider usage capability registry.
 *
 * Every provider with usage support declares how it fetches, who owns
 * credential refresh, which windows it can expose, and where its behavior is
 * documented. A provider cannot quietly gain usage support: the docs
 * enforcement test iterates this registry and requires each documentation
 * file to exist. See `docs/usage-limits/README.md`.
 */

export type CredentialRefreshStrategy = "application" | "provider-cli" | "browser-session" | "none";

export type UsageLimitProviderContext = {
  signal?: AbortSignal;
  /** Injected host platform (from HostProcessPlatform); never read globally. */
  platform: NodeJS.Platform;
  claude?: {
    configDir?: string | undefined;
    cliFallback?: FetchClaudeRateLimitsOptions["cliFallback"];
    fetchImpl?: FetchClaudeRateLimitsOptions["fetchImpl"];
    readKeychain?: FetchClaudeRateLimitsOptions["readKeychain"];
    readText?: (path: string) => Promise<string>;
  };
  codex?: Pick<FetchCodexRateLimitsOptions, "codexHomePath" | "codexBinaryPath">;
  antigravity?: Omit<FetchGeminiRateLimitsOptions, "signal" | "platform">;
  grok?: {
    authReadResult?: GrokAuthReadResult;
    fetchImpl?: typeof fetch;
  };
};

export type ProviderUsageAdapter = {
  readonly provider: ProviderUsageLimits["provider"];
  readonly fetchUsage: (context: UsageLimitProviderContext) => Promise<ProviderUsageLimits>;
  /** Who owns the OAuth token lifecycle the usage reads depend on. */
  readonly refreshStrategy: CredentialRefreshStrategy;
  readonly supportsSession: boolean;
  readonly supportsWeekly: boolean;
  readonly supportsMonthly: boolean;
  readonly supportsBuckets: boolean;
  readonly documentationPath: string;
};

function unavailableResult(
  provider: ProviderUsageLimits["provider"],
  error: string,
): ProviderUsageLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: "unavailable",
    usageMetadata: { failureKind: "usage-unavailable" },
  };
}

/**
 * Generic adapter for providers with no authoritative quota source reachable
 * from this application's architecture. Their credentials live inside the
 * vendor CLI/app; guessing at undocumented endpoints would be worse than an
 * honest `unavailable`. Each has a provider doc explaining what would change
 * this decision.
 */
function unsupportedAdapter(
  provider: ProviderUsageLimits["provider"],
  reason: string,
  documentationPath: string,
): ProviderUsageAdapter {
  return {
    provider,
    fetchUsage: async () => unavailableResult(provider, reason),
    refreshStrategy: "none",
    supportsSession: false,
    supportsWeekly: false,
    supportsMonthly: false,
    supportsBuckets: false,
    documentationPath,
  };
}

export const USAGE_LIMIT_ADAPTERS: ReadonlyArray<ProviderUsageAdapter> = [
  {
    provider: "claude",
    fetchUsage: async (context) =>
      fetchClaudeRateLimits({
        platform: context.platform,
        ...(context.claude?.configDir !== undefined ? { configDir: context.claude.configDir } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.claude?.fetchImpl ? { fetchImpl: context.claude.fetchImpl } : {}),
        ...(context.claude?.readKeychain ? { readKeychain: context.claude.readKeychain } : {}),
        ...(context.claude?.readText ? { readText: context.claude.readText } : {}),
        ...(context.claude?.cliFallback ? { cliFallback: context.claude.cliFallback } : {}),
      }),
    refreshStrategy: "provider-cli",
    supportsSession: true,
    supportsWeekly: true,
    supportsMonthly: false,
    supportsBuckets: false,
    documentationPath: "docs/usage-limits/providers/claude.md",
  },
  {
    provider: "codex",
    fetchUsage: async (context) =>
      fetchCodexRateLimits({
        platform: context.platform,
        ...(context.codex?.codexHomePath ? { codexHomePath: context.codex.codexHomePath } : {}),
        ...(context.codex?.codexBinaryPath
          ? { codexBinaryPath: context.codex.codexBinaryPath }
          : {}),
        // Hidden-PTY fallback crashes ConPTY on Windows; degrade to RPC there.
        allowPtyFallback: context.platform !== "win32",
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    refreshStrategy: "provider-cli",
    supportsSession: true,
    supportsWeekly: true,
    supportsMonthly: false,
    supportsBuckets: false,
    documentationPath: "docs/usage-limits/providers/codex.md",
  },
  {
    provider: "antigravity",
    fetchUsage: async (context) => {
      const { deriveAntigravityRateLimits } = await import("./antigravityUsageMirror.ts");
      if (!context.antigravity) {
        return unavailableResult(
          "antigravity",
          "Google Code Assist quota source is not configured in settings.",
        );
      }
      return deriveAntigravityRateLimits(
        await fetchAntigravityRateLimits({
          ...context.antigravity,
          platform: context.platform,
          ...(context.signal ? { signal: context.signal } : {}),
        }),
      );
    },
    refreshStrategy: "application",
    supportsSession: true,
    supportsWeekly: false,
    supportsMonthly: false,
    supportsBuckets: true,
    documentationPath: "docs/usage-limits/providers/antigravity.md",
  },
  {
    provider: "grok",
    fetchUsage: async (context) =>
      fetchGrokRateLimits({
        ...(context.grok?.authReadResult ? { authReadResult: context.grok.authReadResult } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    refreshStrategy: "provider-cli",
    supportsSession: false,
    supportsWeekly: true,
    supportsMonthly: true,
    supportsBuckets: false,
    documentationPath: "docs/usage-limits/providers/grok.md",
  },
  unsupportedAdapter(
    "cursor",
    "Cursor does not expose a documented subscription-quota API reachable from this server.",
    "docs/usage-limits/providers/cursor.md",
  ),
  unsupportedAdapter(
    "opencode",
    "OpenCode usage depends on a browser session with opencode.ai that this architecture does not own.",
    "docs/usage-limits/providers/opencode.md",
  ),
  unsupportedAdapter(
    "pi",
    "Pi exposes no documented account-level quota API; model access is governed by its own auth store.",
    "docs/usage-limits/providers/pi.md",
  ),
];

export function getUsageLimitAdapter(
  provider: ProviderUsageLimits["provider"],
): ProviderUsageAdapter {
  const adapter = USAGE_LIMIT_ADAPTERS.find((candidate) => candidate.provider === provider);
  if (!adapter) {
    throw new Error(`No usage-limit adapter registered for provider '${provider}'`);
  }
  return adapter;
}
