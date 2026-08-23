# Pi Usage Limits

## Overview

None exposed. Pi manages its own provider credentials and model access; there is no
documented account-level quota API that this server could call, and its SDK does not
surface subscription utilization.

## Supported Windows

- Session: no.
- Weekly: no.
- Monthly: no.
- Model-specific: no.
- Other: none.

## Data Source

None. Pi's driver reports available models from `<agentDir>/auth.json` /
`models.json` (via the Pi SDK) — that is an _authorization_ store, not quota data.
Per README rules, local inference/token counts are never used to fabricate limits.

## Authentication Source

Pi's own agent directory (configurable via `providers.pi.agentDir`). Never read by
the usage subsystem.

## Credential Ownership

`none` (`refreshStrategy: 'none'`) — the Pi CLI/SDK and its upstream providers own
everything, including OAuth flows registered through pi-ai.

## Credential Refresh Behavior

Nothing to refresh; no files are touched.

## Request

None.

## Response Mapping

Single normalized result: `status: 'unavailable'`, `failureKind: 'usage-unavailable'`.

## Remaining-vs-Used Conversion

Not applicable.

## Reset-Time Handling

Not applicable.

## Error Mapping

Only `unavailable`.

## Retry Behavior

No fetches; no retries.

## Stale-Data Behavior

Not applicable.

## Account Switching

Not applicable.

## Platform Notes

Identical everywhere.

## Security Notes

No secrets read or logged. No browser cookies involved.

## Manual Validation

1. Authenticate Pi (`pi /login`) and confirm normal chats.
2. Usage tab shows the neutral unavailable explanation for Pi with no error styling.

## Automated Tests

- Registry coverage in `apps/server/src/rateLimits/usageAdaptersDocs.test.ts`.

## Known Limitations

If Pi exposes a usage/quota API through its SDK, implement it here under the registry
entry and document the exact endpoint before enabling capabilities.
