# Cursor Usage Limits

## Overview

None exposed. Cursor is registered in the usage-limit registry so the UI can render an
honest "unavailable" state, but the adapter reports that no authoritative quota source
is reachable from this application.

## Supported Windows

- Session: no.
- Weekly: no.
- Monthly: no.
- Model-specific: no.
- Other: none.

## Data Source

None. Cursor's subscription quota lives behind its own agent/IDE infrastructure; there
is no documented account-quota API that this server could call. The provider status
probe (`agent about`) reports authentication email and tier but carries no utilization
figures, and local token counts are not quota — estimating plan limits from transcripts
is explicitly out of scope (see README rules).

## Authentication Source

Cursor CLI's own internal store; never read or duplicated here.

## Credential Ownership

`none` from this subsystem's perspective (`refreshStrategy: 'none'`). Cursor owns
everything.

## Credential Refresh Behavior

Nothing to refresh; the adapter makes no requests and touches no files.

## Request

None.

## Response Mapping

The adapter emits a single normalized result:
`status: 'unavailable'`, `failureKind: 'usage-unavailable'`,
error "Cursor does not expose a documented subscription-quota API reachable from this
server." No windows are manufactured.

## Remaining-vs-Used Conversion

Not applicable.

## Reset-Time Handling

Not applicable.

## Error Mapping

Only `unavailable`. The user is never shown a refresh error for a provider that simply
has no quota feed.

## Retry Behavior

No fetches occur, so no retries are scheduled. The coordinator treats `unavailable`
as settled and does not back off or re-poll aggressively.

## Stale-Data Behavior

Unavailability clears/preserves nothing — there is never any usage data for this
provider.

## Account Switching

Not applicable (no usage identity tracked).

## Platform Notes

Identical everywhere; the adapter is platform-independent by construction.

## Security Notes

No secrets read, logged, or transmitted. No browser cookies involved.

## Manual Validation

1. Open the Usage tab with Cursor configured.
2. Confirm the Cursor card shows the neutral "unavailable" explanation and no error
   styling, and that nothing polls when refreshing other providers.

## Automated Tests

- `apps/server/src/rateLimits/usageAdaptersDocs.test.ts` — registry coverage.
- Generic unavailable-result behavior is exercised via the shared adapter contract;
  the coordinator tests cover how `unavailable` settles state and skips polling.

## Known Limitations

If Cursor ships an official usage API, implement it under this registry entry and
update this document before flipping `supports*` capabilities on.
