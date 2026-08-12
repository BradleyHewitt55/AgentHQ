# Provider Slash Commands

## Goal

Make `/` in the chat composer a reliable provider-aware command entry point. It must show the commands supported by the provider instance that will receive the turn, let the user select a command and fill its arguments, and send the resulting provider command unchanged when the turn is submitted.

The composer already has a partial implementation: it renders `ServerProvider.slashCommands` in [`ChatComposer.tsx`](../apps/web/src/components/chat/ChatComposer.tsx), Claude discovers initialization commands in [`ClaudeProvider.ts`](../apps/server/src/provider/Layers/ClaudeProvider.ts), and Pi declares `/reload` in [`PiDriver.ts`](../apps/server/src/provider/Drivers/PiDriver.ts). This plan completes the provider capability contract and live command lifecycle rather than inventing a second command system.

## Scope

- `packages/contracts/src/server.ts`: retain one typed, instance-scoped command shape; extend it only for command metadata that a provider actually supplies (for example argument requirement/defaults), never executable shell data.
- `apps/server/src/provider/providerSnapshot.ts` and `apps/server/src/provider/providerStatusCache.ts`: preserve command lists through provider snapshots, persistence, and refreshes.
- `apps/server/src/provider/Drivers/*.ts` and provider capability/probe layers: make an explicit discovery decision for every shipped provider: Claude, Codex, Cursor, Grok, OpenCode, Pi, and Antigravity.
- `apps/web/src/components/chat/ChatComposer.tsx`, `ComposerCommandMenu.tsx`, and `composerSlashCommandSearch.ts`: provider-scoped discovery, selection, argument editing, send behavior, empty states, and keyboard accessibility.
- Focused provider, contract/cache, composer-search, and composer interaction tests.

## Non-Goals

- Do not create universal T3 commands that pretend every provider supports the same command.
- Do not execute commands in the T3 server, map commands to shell commands, or bypass a provider's approval/permission model.
- Do not expose commands from a non-selected provider instance, a disabled provider, or a stale different thread binding.
- Do not scrape a provider website or hard-code volatile command catalogs when the provider can report them.
- Do not change the existing built-in `/model`, `/plan`, or `/default` behavior except to make grouping and keyboard handling coexist cleanly.

## Provider command model

`ServerProvider.slashCommands` remains capability data keyed by the provider **instance**, not merely its driver kind:

```ts
const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(
    Schema.Struct({ hint: TrimmedNonEmptyString }),
  ),
});
```

A command is only an insertion template. After selecting `/review`, the composer contains `/review ` and remains focused. The user supplies arguments, then submits normally. The ordinary `thread.turn.start` path carries that text to the selected provider adapter. T3 must not parse or execute the provider command itself.

```text
provider capability/probe ──snapshot/cache──> selected instance
                                             │
composer '/' ──filter selected commands──────┤
composer selection ──insert '/name '─────────┤
normal send ──thread.turn.start──> adapter ──> provider CLI/SDK
```

## Implementation plan

### 1. Establish the provider capability matrix

For each shipped driver, document a concrete result in code and tests:

| Provider | Command source | Refresh behavior | Unsupported behavior |
| --- | --- | --- | --- |
| Claude | SDK initialization command list | update snapshot when the provider reports commands changed; preserve workspace commands | Empty list only when SDK reports none |
| Pi | Pi SDK/extension capability if available; otherwise documented built-in commands such as `/reload` | rebuild snapshot after extension/settings reload | Do not advertise commands Pi cannot receive |
| Codex | app-server/CLI-supported command discovery if its protocol exposes it | refresh with provider capabilities | Return an empty list rather than guessed slash commands |
| Cursor | ACP/CLI capability discovery if exposed | refresh on capability refresh | Empty list with no fake catalog |
| Grok | ACP capability discovery if exposed | refresh on capability refresh | Empty list with no fake catalog |
| OpenCode | SDK/CLI command discovery if exposed | refresh on provider refresh | Empty list with no fake catalog |
| Antigravity | provider protocol/CLI capability discovery if exposed | refresh on provider refresh | Empty list with no fake catalog |

The implementation owner must verify each provider's actual protocol before adding a command. “Unsupported” is a valid, intentional result; the composer shows no provider-command group for that selected instance rather than leaking Claude/Pi commands to it.

### 2. Make command discovery durable and live

1. Normalize and de-duplicate command names case-insensitively at the provider boundary, preserving the best description and argument hint. Claude's existing `dedupeSlashCommands` is the reference pattern.
2. Include commands in every initial `ServerProvider` snapshot and cache round-trip. A cold-start cache may show the last known discovery result until the live provider refresh completes.
3. When a provider reports commands changed, refresh or publish the **same instance's** snapshot through `ProviderRegistry`; do not mutate another configured instance of the same driver.
4. Treat a failed discovery as provider availability/status information, not as permission to retain commands from a different account/workspace. Keep the last known list only under the cache validity rules already used by provider status snapshots.

### 3. Complete composer interaction

1. Detect `/` and `/query` at the cursor using the existing `detectComposerTrigger` path.
2. Resolve commands exclusively from `selectedProviderEntry.snapshot.slashCommands`; recompute when the selected instance or a live provider snapshot changes.
3. Group menu rows into **Built-in** and **<selected provider display name>**. Display `/${name}`, description, and input hint; filter name and description with the existing ranked search helper.
4. On mouse, Enter, or Tab selection, replace only the active trigger range with `/${name} `, preserve surrounding prompt text, focus the editor, and leave the command ready for arguments. Escape closes the menu without mutating the draft.
5. A selected zero-argument command is still ordinary draft text until the user submits it. This preserves the same send, lock, offline, attachment, retry, and approval behavior as all other turns.
6. Provide explicit empty states: selected provider unavailable, command discovery pending, and “this provider exposes no slash commands.” Never claim commands are executing before a normal turn has been accepted.

### 4. Validate the end-to-end boundary

- Contract tests decode optional command metadata and reject empty/malformed names.
- Provider tests verify discovery/deduplication, cache snapshot round-trip, live refresh, and unsupported drivers returning an explicit empty list.
- Composer tests cover `/`, fuzzy filtering, provider switching, keyboard/mouse selection, argument hints, Escape, and replacement within non-empty multiline prompts.
- Turn dispatch tests assert selected command text is sent unchanged to the selected provider instance, with no server-side command execution.
- Run focused tests and formatter/typechecks only; do not run repo-wide checks. A manual web pass is optional and requires approval before launching a browser.

## Acceptance criteria

- Typing `/` shows built-in commands plus only the current provider instance's supported commands.
- Selecting a command inserts its exact provider syntax and lets the user enter arguments before sending.
- Submitting sends the command text to the selected provider through the normal turn lifecycle.
- Changing provider instance immediately changes the command list; no cross-provider command leaks occur.
- Every shipped provider has a tested discovery or explicit unsupported decision.
- Provider command updates reach an open composer without reload where its protocol supports updates.

## References

- [`ChatComposer.tsx`](../apps/web/src/components/chat/ChatComposer.tsx)
- [`ComposerCommandMenu.tsx`](../apps/web/src/components/chat/ComposerCommandMenu.tsx)
- [`composerSlashCommandSearch.ts`](../apps/web/src/components/chat/composerSlashCommandSearch.ts)
- [`server.ts`](../packages/contracts/src/server.ts)
- [`providerSnapshot.ts`](../apps/server/src/provider/providerSnapshot.ts)
- [`providerStatusCache.ts`](../apps/server/src/provider/providerStatusCache.ts)
- [`ClaudeProvider.ts`](../apps/server/src/provider/Layers/ClaudeProvider.ts)
- [`PiDriver.ts`](../apps/server/src/provider/Drivers/PiDriver.ts)
