# Codex Usage Limits

## Overview

Exposes ChatGPT/Codex subscription rate limits (5-hour and weekly windows), the plan
tier, and available rate-limit reset credits for the signed-in Codex account.

## Supported Windows

- Session: only when the provider reports one — most current Codex plans are
  **weekly-only**, so `session` is `null`; never synthesized.
- Weekly: yes — canonical 10080 minutes.
- Monthly: no.
- Model-specific: no.
- Other: `planType` ("plus", "pro", …) and `rateLimitResetCredits`.

## Data Source

Three paths, tried in order:

1. **ChatGPT backend** — `GET https://chatgpt.com/backend-api/wham/usage` using the
   Codex access token. Preferred for remote-style homes (a WSL UNC credential home)
   because it avoids spawning a login shell per poll. Also used to _supplement_ the
   RPC result with a missing session window or reset credits
   (`GET .../wham/rate-limit-reset-credits`).
2. **Read-only app-server probe** — spawn `<codex> -c approval_policy=never -s read-only -a never app-server`,
   JSON-RPC `initialize` → `initialized` → `account/rateLimits/read`, then terminate
   cleanly (kill + SIGKILL fallback; resolution waits for exit so the per-home lock
   cannot release while a draining process might rewrite auth.json).
3. **Hidden-PTY `/status` reader** — non-Windows only; types `/status` into a hidden
   interactive codex and parses rendered rows.

Sign-in presence is checked first (`<home>/auth.json`); a missing file yields
`unavailable` without spawning anything.

## Authentication Source

`<CODEX_HOME or settings homePath>/auth.json` → `tokens.access_token` and
`tokens.account_id`. The effective home resolves through `resolveCodexHomeLayout`
(explicit homePath/shadow home win over `~/.codex`).

## Credential Ownership

`provider-cli` — Codex owns its rotating refresh token. Probes may trigger a CLI-side
refresh as a side effect of running codex.

## Credential Refresh Behavior

Never refreshed by this subsystem. Because two application-owned codex processes
refreshing one auth.json concurrently can consume a single-use rotation twice, every
probe serializes through an in-process per-home lock (`codexHomeProcessLock.ts`), so a
usage probe never overlaps another usage probe in the same home.

## Request

Backend headers: `Authorization: Bearer <token>`, `User-Agent: codex-cli`,
`OpenAI-Beta: codex-1`, `originator: Codex Desktop`, and
`ChatGPT-Account-Id: <account_id>` when known. Backend timeout 10 s; RPC init budget
30 s (read deadline 10 s, armed after initialize); PTY budget 15 s. All composed with
the cycle abort signal.

## Response Mapping

| Source field                                            | Normalized                                                |
| ------------------------------------------------------- | --------------------------------------------------------- |
| backend `rate_limit.primary_window.used_percent`        | window `usedPercent`                                      |
| backend `rate_limit.*.limit_window_seconds`             | classifies session (≈300 min) vs weekly (≈10080)          |
| backend `reset_at` (Unix seconds)                       | `resetsAt` → ms                                           |
| backend `plan_type`                                     | `planType`                                                |
| backend `rate_limit_reset_credits` / dedicated endpoint | `rateLimitResetCredits` (counts, expiry normalized to ms) |
| RPC `result.rateLimits.primary`/`secondary`             | same classification                                       |

## Remaining-vs-Used Conversion

Both sources report used percent directly; clamped 0–100, no inversion.

## Reset-Time Handling

Backend reset timestamps are Unix seconds (scaled to ms). Credit expiries accept
seconds or milliseconds. Reset descriptions render at presentation time.

## Error Mapping

- `ok` — windows parsed from any path.
- `unavailable` — auth.json absent (not signed in) or binary missing.
- `error` — RPC failure/timeout, PTY parse failure, sign-in check unavailable/timed out.

## Retry Behavior

No provider-specific Retry-After handling has been observed on these endpoints;
generic stale/backoff policies apply. Isolated provider refresh is enabled (cheap RPC
lane), so activation retries use exponential backoff starting at 30 s capped at 15 min.

## Stale-Data Behavior

Normal 30-minute preservation applies; rate-limited classification preserves 24 hours.

## Account Switching

T3 exposes one Codex credential home per instance configuration. Changing
`providers.codex.homePath`/`shadowHomePath` changes resolved provenance
(`host:<homePath>` vs `host:system`) → generation bump, visible-state clear, forced
provider refresh, old-generation results discarded (covered by coordinator race tests).

## Platform Notes

- **Windows**: hidden-PTY fallback is disabled (ConPTY crash risk); degrade order is
  backend → RPC only. `.cmd` launchers are routed through `cmd.exe /d /c`.
- **macOS/Linux**: full backend → RPC → PTY chain.
- **WSL**: not a T3 driver feature; if a UNC-style home is configured the backend path
  answers first so polls do not wake a login shell.

## Security Notes

Secrets come from auth.json. Tokens and account ids must never be logged or sent to
clients; stderr captured for diagnostics is truncated and never forwarded raw. No
browser cookies involved.

## Manual Validation

1. `codex login` once; confirm `~/.codex/auth.json`.
2. Open the Usage tab — the Codex card shows weekly/session bars plus plan type.
3. Trigger Refresh; verify `codex` briefly spawns and exits (RPC probe) and state updates.

## Automated Tests

- `apps/server/src/rateLimits/codexFetcher.test.ts` — window classification (order,
  drift tolerance, legacy mapping), reset-credit normalization (units, derived next
  expiry, unusable payloads), PTY parsing (`% used`/`% left`, model rows ignored),
  auth presence gating incl. aborted signals.
- `apps/server/src/rateLimits/codexHomeProcessLock.ts` coverage inside the test above —
  same-home serialization, cross-home parallelism, Windows case-insensitive keys.
- Coordinator tests cover account-switch generation races and provenance invalidation.

## Known Limitations

- The PTY `/status` parser understands the standard `5h limit` / `Weekly limit` rows;
  heavily redesigned TUI layouts would need new fixtures.
- WSL homes are answered via the backend request when reachable; there is no
  WSL app-server probe lane.
