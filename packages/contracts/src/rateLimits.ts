/**
 * Usage-limit (subscription quota) contract.
 *
 * The server's usage-limits service polls each provider's authoritative quota
 * source on the user's behalf and normalizes every provider into the shapes in
 * this module before anything crosses the wire. Percentages are *consumed*
 * (`usedPercent`, always clamped 0-100), reset timestamps are Unix
 * milliseconds, and window lengths are canonical minutes (300 = 5h,
 * 10080 = 7d, 43200 = 30d).
 *
 * Credentials never appear here: adapters read them locally and publish only
 * normalized windows plus safe metadata. See `docs/usage-limits/README.md`.
 *
 * @module rateLimits
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Providers with a usage-limit integration. Must match `UsageProviderRegistry`. */
export const UsageLimitProviderId = Schema.Literals([
  "claude",
  "codex",
  "antigravity",
  "grok",
  "cursor",
  "opencode",
  "pi",
]);
export type UsageLimitProviderId = typeof UsageLimitProviderId.Type;

export const UsageLimitStatus = Schema.Literals(["idle", "fetching", "ok", "error", "unavailable"]);
export type UsageLimitStatus = typeof UsageLimitStatus.Type;

/** One normalized usage window, stored as percentage *consumed*. */
export const UsageLimitWindow = Schema.Struct({
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  /** Canonical window length: 300 (5h), 10080 (7d), 43200 (30d). */
  windowMinutes: Schema.Number,
  /** Unix milliseconds; `null` when the provider does not report a reset time. */
  resetsAt: Schema.NullOr(Schema.Number),
  resetDescription: Schema.NullOr(Schema.String),
});
export type UsageLimitWindow = typeof UsageLimitWindow.Type;

/** Named per-model bucket (Gemini/Google Code Assist quota). */
export const UsageLimitBucket = Schema.Struct({
  name: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  windowMinutes: Schema.Number,
  resetsAt: Schema.NullOr(Schema.Number),
  resetDescription: Schema.NullOr(Schema.String),
});
export type UsageLimitBucket = typeof UsageLimitBucket.Type;

export const UsageLimitSource = Schema.Literals(["oauth", "cli", "web", "live-session"]);
export type UsageLimitSource = typeof UsageLimitSource.Type;

export const UsageLimitFailureKind = Schema.Literals([
  "missing-credentials",
  "stale-token",
  "refreshable-credentials-without-token",
  "delegated-refresh-required",
  "deferred-by-live-session",
  "keychain-unavailable",
  "missing-scope",
  "network",
  "server",
  "parse",
  "rate-limited",
  "cli-unavailable",
  "usage-unavailable",
  "unknown",
]);
export type UsageLimitFailureKind = typeof UsageLimitFailureKind.Type;

export const UsageLimitMetadata = Schema.Struct({
  source: Schema.optional(UsageLimitSource),
  attemptedSources: Schema.optional(Schema.Array(UsageLimitSource)),
  failureKind: Schema.optional(UsageLimitFailureKind),
  /**
   * Where the credential was read from (e.g. `credentials-file`,
   * `scoped-keychain`). Names the *kind* of store, never a path or token.
   */
  credentialSource: Schema.optional(TrimmedNonEmptyString),
  /** Runtime identity the credential belongs to (e.g. `host:system`). */
  authProvenance: Schema.optional(TrimmedNonEmptyString),
  deferredByLiveSession: Schema.optional(Schema.Boolean),
  lastSuccessfulSource: Schema.optional(UsageLimitSource),
  /** Unix ms before which automated refreshes must not query this provider again. */
  retryAtMs: Schema.optional(Schema.Number),
});
export type UsageLimitMetadata = typeof UsageLimitMetadata.Type;

/** Codex rate-limit reset credits (wham backend / app-server payloads). */
export const UsageLimitResetCredits = Schema.Struct({
  availableCount: Schema.Number,
  totalEarnedCount: Schema.optional(Schema.Number),
  nextExpiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  credits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        status: Schema.String,
        expiresAt: Schema.NullOr(Schema.Number),
        grantedAt: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
});
export type UsageLimitResetCredits = typeof UsageLimitResetCredits.Type;

/** Normalized usage-limit snapshot for one provider. */
export const ProviderUsageLimits = Schema.Struct({
  provider: UsageLimitProviderId,
  session: Schema.NullOr(UsageLimitWindow),
  weekly: Schema.NullOr(UsageLimitWindow),
  monthly: Schema.optional(Schema.NullOr(UsageLimitWindow)),
  /** Claude Fable scoped weekly window, when reported. */
  fableWeekly: Schema.optional(Schema.NullOr(UsageLimitWindow)),
  /** Named per-model buckets (Google Code Assist quota). */
  buckets: Schema.optional(Schema.Array(UsageLimitBucket)),
  planType: Schema.optional(Schema.NullOr(Schema.String)),
  rateLimitResetCredits: Schema.optional(Schema.NullOr(UsageLimitResetCredits)),
  /** Unix ms of the last successful or attempted update. */
  updatedAt: Schema.Number,
  error: Schema.NullOr(Schema.String),
  status: UsageLimitStatus,
  usageMetadata: Schema.optional(UsageLimitMetadata),
});
export type ProviderUsageLimits = typeof ProviderUsageLimits.Type;

/** Full usage-limit state pushed to clients. */
export const UsageLimitsSnapshot = Schema.Struct({
  readAt: Schema.String,
  providers: Schema.Array(ProviderUsageLimits),
});
export type UsageLimitsSnapshot = typeof UsageLimitsSnapshot.Type;

export const UsageLimitsRefreshInput = Schema.Struct({
  /** Omit to refresh every provider. Manual refreshes bypass freshness throttling. */
  provider: Schema.optional(UsageLimitProviderId),
});
export type UsageLimitsRefreshInput = typeof UsageLimitsRefreshInput.Type;
