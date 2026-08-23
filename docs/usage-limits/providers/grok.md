# Grok Usage Limits

## Overview

Exposes xAI/Grok subscription usage — weekly credits when the plan has them, or the
monthly included budget on unified-billing accounts.

## Supported Windows

- Session: no.
- Weekly: yes — `creditUsagePercent`, canonical 10080 minutes.
- Monthly: yes (fallback) — derived from `used / monthlyLimit`, canonical 43200 minutes.
- Model-specific: no.
- Other: tier surfaced through `usageMetadata.authProvenance`.

## Data Source

Grok CLI billing proxy:

1. `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` (weekly credits)
2. `GET https://cli-chat-proxy.grok.com/v1/billing` (monthly fallback for
   unified-billing accounts whose credits view omits usage)

`GROK_CLI_CHAT_PROXY_BASE_URL` overrides the base when the user's Grok configuration
does. 10-second timeout composed with the cycle abort signal.

## Authentication Source

The Grok CLI auth file: `$GROK_HOME/auth.json` (default `~/.grok/auth.json`). Multiple
entries may exist; the standard `https://auth.x.ai` issuer is preferred, with expired
preferred entries still outranking alternate-issuer compatibility entries. A token-less
file means signed out (`missing`), not an error.

## Credential Ownership

`provider-cli` — the Grok CLI owns token refresh. This integration only reads.

## Credential Refresh Behavior

Nothing is ever written to Grok's auth file. An expired stored session reports
`failureKind: 'delegated-refresh-required'` and asks the user to run Grok so the CLI
rotates its token — a genuine sign-out instead reads as `unavailable`, so users are
never told to log in again unnecessarily.

## Request

```
Authorization: Bearer <accessToken>
X-XAI-Token-Auth: xai-grok-cli
Accept: application/json
x-userid: <user id>          # when present in the auth entry
```

## Response Mapping

| Field                                    | Normalized                                 |
| ---------------------------------------- | ------------------------------------------ |
| `creditUsagePercent`                     | `weekly.usedPercent`                       |
| `currentPeriod.end` / `billingPeriodEnd` | `resetsAt` → ms + description              |
| `subscriptionTier`                       | provenance label                           |
| `used.val` / `monthlyLimit.val`          | `monthly.usedPercent = used / limit × 100` |

A weekly `currentPeriod` is trusted only when it matches the declared billing period,
so monthly accounts reporting a spurious weekly period are not misread; an omitted
protobuf zero with matching bounds reads as 0% used.

## Remaining-vs-Used Conversion

Weekly credits arrive as used percent (stored as-is, clamped). Monthly arrives as
absolute money values → converted via `used / limit × 100`.

## Reset-Time Handling

ISO timestamps → Unix ms; invalid/absent become null.

## Error Mapping

- `ok` — weekly or monthly window present.
- `unavailable` — not signed in, or a 200 response that names no quota at all.
- `error` — HTTP 401/403 ("unauthorized"), other HTTP failures, network failures,
  unreadable auth file (pre-redacted message), expired stored token
  (`delegated-refresh-required`).

## Retry Behavior

No provider-specific Retry-After handling observed; generic policies apply. Isolated
activation retries enabled (cheap HTTPS fetch).

## Stale-Data Behavior

Normal 30-minute preservation; rate-limited classification preserves 24 hours. The
monthly fallback deliberately returns `error` (not `unavailable`) on request failure so
a recent good monthly snapshot stays visible under stale policy.

## Account Switching

One Grok identity per environment (the CLI's own file). Provenance is constant
(`host:grok-auth-file`) plus the account label in metadata; no managed switching exists.

## Platform Notes

Identical everywhere: one JSON file read plus plain HTTPS. No WSL-specific behavior;
T3 does not resolve WSL Grok homes.

## Security Notes

Secret source: the auth file only. Its contents and path must never appear in logs or
errors (read errors return fixed strings). No browser cookies involved.

## Manual Validation

1. `grok login`; confirm `$GROK_HOME/auth.json`.
2. Open the Usage tab — the Grok card shows the weekly bar (or monthly on unified
   billing).
3. Let the token expire (or edit expiry) and confirm the card reports "run Grok once"
   rather than a login prompt, then run `grok` and watch it recover.

## Automated Tests

- `apps/server/src/rateLimits/grokFetcher.test.ts` — preferred issuer selection,
  alternate-issuer fallbacks, token-less files as missing, redaction of read errors,
  freshness skew, weekly mapping, zero-credit confirmation, monthly fallback request
  sequence, delegated-refresh-required without any fetch attempt, 401/403 handling,
  no-auth-file mutation.
- Coordinator tests cover stale preservation and Retry-After gating generically.

## Known Limitations

- Only the documented billing-proxy fields are parsed; xAI changes require new
  fixtures here first.
