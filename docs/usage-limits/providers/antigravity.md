# Antigravity Usage Limits

## Overview

Exposes shared Google Code Assist quota for the Gemini sign-in that the Antigravity
CLI rides on, as named per-model buckets plus a derived session summary. Antigravity
itself is never queried — its CLI keeps tokens in the OS keyring and consumes the same
Google Code Assist quota as Gemini CLI.

## Supported Windows

- Session: derived summary = most-consumed bucket.
- Weekly: no.
- Monthly: no.
- Model-specific: yes — one bucket per reported model (e.g. "Pro", "Flash").
- Other: none.

## Data Source

1. `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` with
   `{"metadata": {"ideType": "GEMINI_CLI", "pluginType": "GEMINI"}}` →
   `cloudaicompanionProject` (project id).
2. `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` with
   `{"project": "<project id>"}` → per-model buckets.

Both carry a 10-second timeout composed with the cycle abort signal.

## Authentication Source

`~/.gemini/oauth_creds.json` (`access_token`, `refresh_token`, `expiry_date`).
Reading this file is an **opt-in** setting: `settings.usageLimits.geminiCliOauthEnabled`
(default false). When disabled the provider reports `unavailable` and nothing touches
the credential store.

## Credential Ownership

`application` — Gemini CLI has no long-lived refresher, so this is the one provider
whose access token this application refreshes.

## Credential Refresh Behavior

If `expiry_date` has passed (or a 401 arrives), the refresh token is exchanged at
`https://oauth2.googleapis.com/token` using the OAuth client identity extracted from
the installed Gemini CLI package (or explicit `GEMINI_CLI_OAUTH_CLIENT_ID/SECRET`
environment overrides). The refreshed credentials are persisted atomically:
write `<file>.<pid>.tmp`, then rename over the original — the active file is never
truncated before its replacement exists.

## Request

Standard JSON POSTs with `Authorization: Bearer <token>`; bodies shown above. No
secrets in bodies beyond the token header.

## Response Mapping

| Field                      | Normalized                                             |
| -------------------------- | ------------------------------------------------------ |
| bucket `remainingFraction` | `usedPercent = (1 - remainingFraction) × 100`, clamped |
| bucket `resetTime`         | `resetsAt` → Unix ms                                   |
| bucket `modelId`           | humanized bucket `name`                                |
| most-consumed bucket       | `session`                                              |

Equivalent buckets are deduplicated, preferring known model names and shorter labels.

## Remaining-vs-Used Conversion

Fractional remaining → consumed percent via `(1 − remainingFraction) × 100`.

## Reset-Time Handling

ISO timestamps parsed to Unix ms; invalid values become null.

## Error Mapping

- `ok` — buckets present.
- `unavailable` — setting disabled, or credentials missing (no sign-in).
- `error` — refresh failure, project id unavailable, HTTP failures, malformed quota
  payloads ("Quota response contained no usable buckets").

The mirror (`antigravityUsageMirror.ts`) converts any non-ok source result into an
Antigravity **unavailable** with an explanatory message — a failed Google read must
never be reported as a failed _Antigravity_ request, because none was made.

## Retry Behavior

Exactly one forced refresh-and-retry after a 401 quota response (project id is
re-resolved when possible). No loop. Generic stale/backoff policies apply afterwards;
the adapter participates in isolated activation retries.

## Stale-Data Behavior

Normal 30-minute preservation applies. Rate-limited classification preserves 24 hours.

## Account Switching

Single Gemini credential store per environment. Changing the opt-in setting triggers
a generation bump + forced refresh through the settings watcher; results captured
under a stale identity are discarded by provenance checks.

## Platform Notes

Identical on macOS/Windows/Linux — everything is file + HTTPS based. Client-identity
extraction scans common install layouts of `@google/gemini-cli`; if none is found,
refresh fails with `Token refresh failed` rather than guessing.

## Security Notes

Secret sources: `oauth_creds.json`, client-id/secret constants embedded in the local
CLI install. Tokens and file contents are never logged or sent to clients. No browser
cookies involved. Atomic persistence avoids exposing truncated credential files to
concurrent readers (including the Gemini CLI itself).

## Manual Validation

1. `gemini` once with the account you care about; confirm `~/.gemini/oauth_creds.json`.
2. Enable Settings → usage limits → Gemini CLI OAuth reads.
3. Open the Usage tab: Antigravity card lists model buckets; toggle the setting off
   and confirm the card flips to "unavailable" without errors.

## Automated Tests

- `apps/server/src/rateLimits/geminiUsageFetcher.test.ts` — fraction conversion,
  dedupe/session derivation, atomic persistence ordering, ENOENT vs real read errors,
  disabled opt-in, missing credentials (network untouched), expired-token refresh +
  persistence, single 401 retry, malformed payloads.
- `apps/server/src/rateLimits/usageLimitCoordinator.test.ts` — settings-driven
  credential-change invalidation.

## Known Limitations

- Buckets report a 60-minute window because Google's payload does not state one; the
  reset timestamp is authoritative.
- If no Gemini CLI install can be located, application-owned refresh cannot run (no
  client identity) and the provider surfaces a refresh error until the user runs
  `gemini` once.
