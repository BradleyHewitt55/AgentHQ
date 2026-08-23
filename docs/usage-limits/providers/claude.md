# Claude Usage Limits

## Overview

Exposes Claude subscription utilization (5-hour and 7-day windows, plus the Fable
scoped weekly window on plans that report it) for the account whose OAuth
credentials Claude Code stores locally.

## Supported Windows

- Session: yes — `five_hour`, canonical 300 minutes.
- Weekly: yes — `seven_day`, canonical 10080 minutes.
- Monthly: no.
- Model-specific: `fableWeekly` (Fable scoped weekly limit).
- Other: none.

## Data Source

`GET https://api.anthropic.com/api/oauth/usage` — the same endpoint the Claude Code
CLI uses. Live-session data may also arrive through the provider runtime event bus
(Claude Agent SDK structured `/usage` snapshots), ingested as
`source: 'live-session'`.

## Authentication Source

OAuth bearer token read from, in order:

1. macOS Keychain scoped by config dir (`Claude Code-credentials <dir>`) when a
   custom config dir is configured,
2. legacy unscoped macOS Keychain item (`Claude Code-credentials`),
3. `<config dir>/.credentials.json` (`claudeAiOauth.accessToken`).

The config dir follows the provider settings (`providers.claudeAgent.homePath`),
then `CLAUDE_CONFIG_DIR`, then `~/.claude`. A real legacy token outranks a
refresh-only scoped item because this app cannot refresh Claude credentials.

## Credential Ownership

`provider-cli` — Claude Code owns token rotation and refresh. This integration is
read-only by design: competing refreshes against credentials owned by the CLI can
invalidate single-use refresh tokens.

## Credential Refresh Behavior

Never modified here. If the access token is expired we still send it (the usage
endpoint accepts expired creds); if it fails with 401/403 the adapter reports
`failureKind: 'stale-token'` and the next real Claude session repairs the store.

## Request

```
GET /api/oauth/usage
Authorization: Bearer <oauth access token>
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/2.1.0
```

10-second timeout; composed with the cycle's abort signal. API keys are never sent —
they bill per token and are not subscription quota.

## Response Mapping

| Provider field                                                             | Normalized                                 |
| -------------------------------------------------------------------------- | ------------------------------------------ |
| `five_hour.utilization`                                                    | `session.usedPercent` (clamped)            |
| `five_hour.resets_at`                                                      | `session.resetsAt` → Unix ms + description |
| `seven_day.*`                                                              | `weekly.*`                                 |
| `limits[]` where `kind === 'weekly_scoped'` and model display name "Fable" | `fableWeekly`                              |
| `fable_weekly` / `fable_seven_day` / `seven_day_fable`                     | `fableWeekly` fallbacks                    |

## Remaining-vs-Used Conversion

The endpoint already reports used percentage (`utilization`); stored as-is after
clamping. No inversion.

## Reset-Time Handling

`resets_at` may be ISO 8601 or epoch seconds/milliseconds; parsed to Unix ms via the
shared heuristic (>1e11 means already ms). Descriptions render at presentation time.

## Error Mapping

- `ok` — any window present.
- `unavailable` — no OAuth credentials found (`missing-credentials`; API-key billing
  or not signed in). Never an alarming error.
- `error` with `failureKind`:
  - `stale-token` (401, non-scope 403),
  - `missing-scope` (403 mentioning `user:profile`),
  - `rate-limited` (429; carries `retryAtMs`),
  - `server` (5xx), `parse` (malformed JSON), `network` (timeouts/DNS),
  - `cli-unavailable` (CLI fallback wired but failed).

## Retry Behavior

HTTP 429 parses `Retry-After` (delay-seconds or HTTP-date, capped at 24h) into
`usageMetadata.retryAtMs`; automated refreshes skip the provider until it elapses.
A CLI fallback hook exists but is not wired in production: T3 does not automate the
interactive Claude CLI for background reads (hidden-PTY automation is unreliable on
Windows and heavy everywhere).

## Stale-Data Behavior

Normal 30-minute preservation applies; rate-limited failures preserve up to 24 hours.

## Account Switching

T3 has one system-default credential home per environment (no managed account
switcher). Changing `providers.claudeAgent.homePath` changes the resolved provenance
(`host:<configDir>` vs `host:system`); the coordinator bumps that provider's
generation, clears visible state, forces a refresh, and discards any in-flight result
captured under the old identity.

## Platform Notes

- **macOS**: Keychain items are read through `/usr/bin/security find-generic-password`
  with a 5 s timeout; scoped service names include the explicit config dir.
- **Windows/Linux**: `.credentials.json` only; keychain steps return empty quickly.
- **WSL**: T3 does not resolve WSL Claude homes; unsupported (documented limitation).

## Security Notes

Secret sources are the files/services above. Tokens, file contents, and absolute
paths must never be logged or sent to clients. No browser cookies involved; nothing
to clear.

## Manual Validation

1. Sign in to Claude Code (`claude` once), confirm `~/.claude/.credentials.json` or
   the Keychain entry exists.
2. Start the server, open the Usage tab: the Claude card shows 5-hour/weekly bars.
3. Click Refresh and observe `server.subscribeUsageLimits` frames updating state.

## Automated Tests

- `apps/server/src/rateLimits/claudeFetcher.test.ts` — window parsing, Fable scoped +
  legacy fields, clamping, credential source ordering, API-key unavailability,
  stale-token/rate-limited/server/network/scope classification, Retry-After parsing,
  CLI-fallback merge, live-window mapping.
- `apps/server/src/rateLimits/usageLimitCoordinator.test.ts` — live ingestion
  (partial merge, dedupe, freshness gating) and stale behavior.
- `apps/server/src/rateLimits/claudeCredentials.test.ts` — credential parsing/ordering.

## Known Limitations

- The interactive-CLI usage-panel fallback (Orca's hidden-PTY path) is intentionally
  not wired; Windows safety plus avoiding surprise Claude processes outweigh the rare
  case where OAuth answers nothing while the CLI would.
- WSL Claude homes are not resolved.
