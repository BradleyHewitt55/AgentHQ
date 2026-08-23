# OpenCode Usage Limits

## Overview

None exposed. T3's OpenCode driver connects to the user's OpenCode server/CLI, whose
upstream provider accounts live inside that server. The opencode.ai "Go" subscription
quota (which Orca reads through browser session cookies) is not reachable from this
architecture: T3 has no Electron cookie jar on the server side and no mechanism to
obtain `auth` / `__Host-auth` cookies for opencode.ai.

## Supported Windows

- Session: no.
- Weekly: no.
- Monthly: no.
- Model-specific: no.
- Other: none.

## Data Source

None today. Per the README source-ordering rules, a stable API outranks scraping; the
only known quota surface for Go subscriptions is the server-rendered workspace page at
`https://opencode.ai/workspace/<id>/go` behind session cookies, plus the
`https://opencode.ai/_server` function endpoint for workspace discovery — both require
a browser session this application does not own.

## Authentication Source

Nothing read. (The driver authenticates to user-configured OpenCode _servers_ with
HTTP Basic credentials from settings — those are transport credentials for chats, not
subscription-quota identity.)

## Credential Ownership

`none` (`refreshStrategy: 'none'`). opencode.ai owns its sessions.

## Credential Refresh Behavior

No credential is touched; no requests are made.

## Request

None.

## Response Mapping

Single normalized result: `status: 'unavailable'`,
`failureKind: 'usage-unavailable'`, explaining that usage depends on an opencode.ai
browser session this architecture does not own.

## Remaining-vs-Used Conversion

Not applicable.

## Reset-Time Handling

Not applicable.

## Error Mapping

Only `unavailable` — never an error, because nothing fails.

## Retry Behavior

No fetches; no retries.

## Stale-Data Behavior

Not applicable.

## Account Switching

Not applicable.

## Platform Notes

Identical everywhere.

## Security Notes

No secrets read or logged. Should cookie support ever land, it must follow the README
checklist: isolated session jar, only `auth`/`__Host-auth` forwarded, cleared after
every request, config changes invalidating previous snapshots.

## Manual Validation

1. Configure OpenCode normally and confirm chats work with zero usage-limit traffic.
2. Usage tab shows the neutral unavailable explanation for OpenCode.

## Automated Tests

- Registry coverage in `apps/server/src/rateLimits/usageAdaptersDocs.test.ts`.

## Known Limitations

Deliberate: no cookie capture mechanism exists in T3. If one lands (e.g. settings-based
cookie entry), implement the Orca Go flow (workspace discovery → candidate pages →
rolling/weekly/monthly parsing) under this registry entry with config-change
invalidation tests.
