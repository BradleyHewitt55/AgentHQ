# Usage Limits (Subscription Quota)

This subsystem tracks **subscription quota** — the "how much of your Claude/Codex/Grok plan
you have used" numbers that providers expose through their own authenticated endpoints.
It is deliberately separate from token accounting (`docs` → Usage page charts), which is
derived from local transcripts and priced with LiteLLM rates.

The design mirrors [stablyai/orca](https://github.com/stablyai/orca)'s rate-limit system
(`src/main/rate-limits/`) as closely as this application's architecture allows.

## How it works

```
provider CLIs/credential files        central UsageLimitCoordinator          clients
┌───────────────────────┐   fetch    ┌──────────────────────────────┐   push   ┌──────────┐
│ claude credentials    │◄───────────│ apps/server/src/rateLimits/  │─────────►│ web pills│
│ codex auth.json       │            │  usageLimitCoordinator.ts    │          │ Usage tab│
│ ~/.gemini oauth_creds │            │  + one adapter per provider  │          │          │
│ GROK_HOME auth.json   │            └──────────────────────────────┘          └──────────┘
└───────────────────────┘                     ▲
                                              │ active-window gating
                                   BackgroundPolicy foreground leases
```

- **One owner.** Only the server's `UsageLimitsService` polls providers. UI components
  never make usage requests and never see credentials; they consume a normalized
  `UsageLimitsSnapshot` pushed over `server.subscribeUsageLimits`.
- **One normalized model.** Every provider produces
  `ProviderUsageLimits` (`packages/contracts/src/rateLimits.ts`): percentage _consumed_
  clamped to 0–100, canonical window minutes (300 = 5h, 10080 = 7d, 43200 = 30d),
  reset timestamps normalized to Unix milliseconds, plus typed provider-specific extras
  (`planType`, Codex reset credits, Gemini buckets, Claude Fable weekly).
- **Explicit adapters.** Each provider registers a `ProviderUsageAdapter`
  (`apps/server/src/rateLimits/usageAdapters.ts`) declaring its fetch strategy,
  credential-refresh ownership, supported windows, and its documentation path.

## Refresh architecture

| Behavior           | Value                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Background poll    | every 15 min (`DEFAULT_POLL_MS`), only while an app window is present, visible, focused                                                        |
| Activation refresh | on focus/show/resume equivalents; skips healthy data younger than 5 min                                                                        |
| Manual refresh     | always works: bypasses throttling, queues exactly one follow-up behind an in-flight cycle, waits for it                                        |
| Retry-After        | automated refreshes skip a provider until `usageMetadata.retryAtMs`; manual refresh may force                                                  |
| Failure backoff    | isolated per-provider retries start at 30 s, double per failure, cap at 15 min, reset on ok/unavailable                                        |
| Stale policy       | transient errors keep the last snapshot visible for 30 min; rate-limited failures keep it for 24 h; explicit unavailability clears immediately |

Active-window detection uses the existing `BackgroundPolicy` client activity leases
(visible + focused foreground clients) instead of Electron window events, so the same
policy covers desktop, web, and remote sessions. A false→true transition of
`shouldRunOpportunisticWork` is the focus/restore equivalent and triggers an activation
freshness evaluation.

- **Live-session aware.** Claude/Codex runtime events merge into state as source: 'live-session'; fresh live data suppresses redundant OAuth polls.
  arrive over the provider runtime event bus and are ingested as `source: 'live-session'`.
  Fresh live data (<5 min old) suppresses redundant OAuth polling for that provider;
  partial live payloads merge instead of clearing the other window.

## Credential ownership

Every adapter declares who owns the OAuth token lifecycle:

| Provider                         | Refresh owner   | Notes                                                                                                                  |
| -------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Claude                           | provider CLI    | we only read; never rotate Claude Code credentials                                                                     |
| Codex                            | provider CLI    | probes serialize per credential home so two app-owned codex processes cannot double-consume the rotating refresh token |
| Antigravity (Google Code Assist) | **application** | the one provider whose token we refresh; writes are atomic (temp file + rename); opt-in via settings                   |
| Grok                             | provider CLI    | expired tokens report `delegated-refresh-required`                                                                     |
| Cursor / OpenCode / Pi           | n/a             | no authoritative quota source reachable; documented in their pages                                                     |

## Security

- Credentials never cross the wire; only normalized windows and safe metadata do.
- Tokens, cookies, and credential paths are redacted from logs and error messages.
- No cookie-based integration exists today; if one lands it must use an isolated
  session jar cleared after each request (see the checklist below).

## Adding Usage Limits for a New Provider

Mandatory checklist — a provider without its document under `providers/<id>.md` fails
the docs-enforcement test (`usageAdaptersDocs.test.ts`).

- [ ] Identify the authoritative usage/quota source.
- [ ] Confirm whether usage data is subscription quota, API billing, or both.
- [ ] Identify where authentication credentials are stored.
- [ ] Determine who owns token refresh.
- [ ] Do not implement competing token refresh when the provider CLI owns rotation.
- [ ] Implement the normalized ProviderUsageLimits contract.
- [ ] Convert remaining quota into canonical usedPercent.
- [ ] Normalize reset timestamps to Unix milliseconds.
- [ ] Classify missing credentials as unavailable where appropriate.
- [ ] Classify transient network/server failures as error.
- [ ] Parse Retry-After when rate limited.
- [ ] Add the provider to centralized refresh orchestration.
- [ ] Decide whether isolated provider refresh is safe.
- [ ] Add generation/provenance protection for account-aware providers.
- [ ] Ensure credentials never reach renderer state.
- [ ] Redact provider secrets from logs/errors.
- [ ] Add request timeouts.
- [ ] Add cancellation where supported.
- [ ] Add stale-data tests.
- [ ] Add account-switch race tests if applicable.
- [ ] Add provider parsing fixtures.
- [ ] Add manual refresh tests.
- [ ] Add unavailable/missing-credential tests.
- [ ] Add token-expiry tests.
- [ ] Add platform-specific tests where required.
- [ ] Create docs/usage-limits/providers/<provider>.md.
- [ ] Update the provider capability registry.
- [ ] Verify UI presentation.
- [ ] Verify manual refresh.
- [ ] Verify background polling.
- [ ] Verify application focus/resume refresh.

- **Surfaces.** Web renders cards (Usage tab) + floating pills. Mobile has no usage surface yet; the RPC/subscription is client-agnostic, so adding one is presentation-only.

## Provider documents

- [`claude`](providers/claude.md)
- [`codex`](providers/codex.md)
- [`antigravity`](providers/antigravity.md)
- [`grok`](providers/grok.md)
- [`cursor`](providers/cursor.md)
- [`opencode`](providers/opencode.md)
- [`pi`](providers/pi.md)

## Key files

| Path                                                  | Purpose                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `packages/contracts/src/rateLimits.ts`                | wire schemas for the normalized model                          |
| `apps/server/src/rateLimits/usageLimitCoordinator.ts` | central orchestration (polling, stale policy, generations)     |
| `apps/server/src/rateLimits/UsageLimitsService.ts`    | Effect layer wiring coordinator to settings/events/policy      |
| `apps/server/src/rateLimits/usageAdapters.ts`         | capability registry + docs enforcement anchor                  |
| `apps/server/src/rateLimits/<provider>*Fetcher*.ts`   | provider networking/parsing                                    |
| `packages/client-runtime/src/state/server.ts`         | `usageLimits` subscription atom + `refreshUsageLimits` command |
| `apps/web/src/components/usage/UsageLimits.tsx`       | shared presentation (cards + pills)                            |
