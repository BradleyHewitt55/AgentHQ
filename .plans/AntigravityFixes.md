# Antigravity Driver — Remediation Plan

_Created: 2026-07-22_
_Source: code review of commit `0db8a16d` ("feat: add Antigravity driver and settings")_

Scope: `apps/server/src/provider/Drivers/AntigravityDriver.ts`,
`apps/server/src/provider/Layers/AntigravityAdapter.ts`, plus the Pi
driver/adapter where the same defect was inherited by copy-paste.

Status values: `TODO` | `IN_PROGRESS` | `BLOCKED` | `DONE`

Counts: `26` items (24 original + `F001`/`F002`) — blocking `3`, correctness `11`,
smells `10`, tests `1`, extra `2`. All `26` are `DONE`.

Landed on `fix/antigravity-remediation`. New modules:
`apps/server/src/provider/Layers/antigravityLaunch.ts` (argv + model catalog +
output sanitizer), `apps/server/src/provider/Layers/adapterShared.ts` (shared
adapter helpers and the typed event draft), and
`apps/server/src/provider/Drivers/unsupportedTextGeneration.ts`. Tests:
`antigravityLaunch.test.ts`, `AntigravityAdapter.test.ts`,
`AntigravityDriver.test.ts`.

---

## Phase 0 — Prerequisite investigation

These answers change the shape of Phase 1 and Phase 2. Do them first.

- [x] `I001` Determine the real `agy` CLI surface.
  - Status: `DONE` (probed against `agy` v1.1.5 on Windows, 2026-07-22)
  - Blocks: `B001`, `B003`, `C001`, `C003`

  `agy --help` (v1.1.5):

  ```
  Usage of agy.exe:
    --add-dir                       Add a directory to the workspace (repeatable) (default [])
    --agent                         Agent for the current CLI session
    -c                              Short alias for --continue
    --continue                      Continue the most recent conversation
    --conversation                  Resume a previous conversation by ID
    --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
    --effort                        Reasoning effort for the current CLI session (low|medium|high)
    -i                              Short alias for --prompt-interactive
    --log-file                      Override CLI log file path
    --mode                          Set the agent execution mode for this session (accept-edits, plan)
    --model                         Model for the current CLI session
    --new-project                   Create a new project for this session
    -p                              Short alias for --print
    --print                         Run a single prompt non-interactively and print the response
    --print-timeout                 Timeout for print mode wait (default 5m0s)
    --project                       Project ID for the current CLI session
    --prompt                        Alias for --print
    --prompt-interactive            Run an initial prompt interactively and continue the session
    --sandbox                       Run in a sandbox with terminal restrictions enabled

  Available subcommands:
    agent / agents  List available agents
    changelog       Show changelog and release notes
    help            Show help for subcommands
    install         Configure environment paths and shell settings
    models          List available models
    plugin/plugins  Manage plugins
    update          Update CLI
  ```

  Answers:
  - **Resume: YES.** `--continue` / `-c` (most recent conversation),
    `--conversation <ID>` (by ID), and `--project <ID>` (scope a session to a
    project). `B003` option 1 is viable. Open sub-question for the
    implementation: whether `--print` surfaces the conversation/project ID on
    stdout. If it does not, fall back to `--new-project` on turn 1 and
    `--continue` on subsequent turns — note `--continue` is *global* ("most
    recent"), so it is only safe when turns are serialized per session; prefer
    `--project` scoping if an ID can be captured.
  - **stdin prompt input: NO.** `-p` / `--print` requires its value as the flag
    argument (`echo x | agy -p` → `flag needs an argument: -p`). There is no
    `@file` syntax and no positional prompt.
  - **Streaming / NDJSON: NO.** There is no `--output-format`. Output is plain
    text on stdout. `C003` therefore means "emit `content.delta` per stdout
    chunk as it arrives + strip ANSI", not "parse a structured stream".
  - **Permission mode short of full bypass: YES.** `--mode accept-edits`,
    `--mode plan`, and `--sandbox` (terminal restrictions). `B001` is fully
    implementable — the "fail `startSession`" fallback is NOT needed.

- [x] `I002` Confirm how `agy` is distributed on Windows.
  - Status: `DONE`
  - Blocks: `B002`
  - **Native `.exe`**, not an npm `.cmd` shim:
    `C:\Users\hewit\AppData\Local\agy\bin\agy.exe` (~166 MB Go binary).
  - Therefore `B002` does **not** need the `.cmd`-shim-following logic from
    `ClaudeExecutable.ts`; plain `resolveSpawnCommand` suffices for PATH/PATHEXT
    resolution. The `C001`-before-`B002` ordering constraint still stands, since
    `resolveSpawnCommand` may still return `shell: true` on other setups.

---

## Phase 0b — Additional findings from the CLI probe

These were discovered while answering `I001`/`I002` and are **not** in the
original review. Treat them as first-class work items.

- [x] `F001` Two entries in `DEFAULT_EFFORT_BY_MODEL` produce invalid `--model`
      values — these models are broken today, not merely inconsistent.
  - Status: `DONE`
  - Severity: `High`
  - File: `AntigravityAdapter.ts:37-44`
  - The CLI's accepted `--model` values (from its own error output) are:

    ```
    Gemini 3.6 Flash (High) / (Medium) / (Low)
    Gemini 3.5 Flash (High) / (Medium) / (Low)
    Gemini 3.1 Pro   (High) / (Low)          <- no Medium
    Claude Sonnet 4.6 (Thinking)             <- Thinking only
    Claude Opus 4.6   (Thinking)             <- Thinking only
    GPT-OSS 120B      (Medium)
    ```

  - The adapter maps `"Claude Sonnet 4.6" → "High"` and
    `"Claude Opus 4.6" → "High"`. Both yield an unrecognised `--model` and the
    turn dies at spawn. Correct value for both is `"Thinking"`.
  - Note the effort vocabulary is `{High, Medium, Low, Thinking}` — use exactly
    this set for the `S005` regex tightening.
  - Also note `agy models` prints a *different*, slug-shaped list
    (`gemini-3.6-flash-high`, `claude-opus-4-6-thinking`, …). `--model` accepts
    the **display-name** form, so the existing comment at `:32-36` is correct;
    do not "fix" it toward the slugs. `C007`'s probe should not parse
    `agy models` output as `--model` input.

- [x] `F002` `--effort` is a separate flag from the model suffix.
  - Status: `DONE`
  - Severity: `Low`
  - Decide one mechanism and use it consistently. Suffix-in-`--model` is
    already proven to work; `--effort ""` appears in the CLI's own error text,
    implying it defaults to empty when unset. Prefer keeping the suffix and not
    passing `--effort` at all, and say so in a comment.

---

## Phase 1 — Blocking

Do not ship the provider as `available: true` in the picker
(`apps/web/src/session-logic.ts:57`) until these three are `DONE`.

- [x] `B001` Honour `runtimeMode` instead of hardcoding permission bypass
  - Status: `DONE`
  - Severity: `Critical` (security)
  - File: `apps/server/src/provider/Layers/AntigravityAdapter.ts:155`
  - Problem: `--dangerously-skip-permissions` is passed on every turn.
    `input.runtimeMode` is stored on the session at `:118` and never read.
    A user who selects "approval required" gets unrestricted shell/filesystem
    access with no indication.
  - Fix: add a `runtimeModeToAntigravityArgs(mode)` helper mirroring
    `ClaudeAdapter.ts:3437` (`runtimeModeToPermission`) and
    `CodexSessionRuntime.ts:264` (`runtimeModeToThreadConfig`). Persist the
    mode on `AntigravityContext` so `runTurn` can read it — `runTurn` currently
    receives no mode argument.
  - If the CLI has no sub-bypass mode (per `I001`): fail `startSession` with a
    `ProviderAdapterValidationError` for any mode other than `full-access`
    rather than silently escalating.
  - Acceptance: a session started in `approval-required` either restricts the
    CLI or refuses to start. No code path reaches
    `--dangerously-skip-permissions` without `full-access`.

- [x] `B002` Route the spawn through `resolveSpawnCommand`
  - Status: `DONE`
  - Severity: `Critical` (default config is broken on Windows)
  - File: `apps/server/src/provider/Layers/AntigravityAdapter.ts:151`
  - Problem: `ChildProcess.make(binaryPath, …)` is called directly with a bare
    `"agy"`. No PATH/PATHEXT resolution; an npm `.cmd` shim fails with
    `spawn EINVAL`. Rationale documented at `ClaudeExecutable.ts:53`.
  - Fix: follow the established pattern — `GrokProvider.ts:149`,
    `CodexSessionRuntime.ts:723`, `opencodeRuntime.ts`, `AcpSessionRuntime.ts:332`.
    Requires threading `SpawnExecutableResolution` into `AntigravityDriverEnv`
    and through `makeAntigravityAdapter`.
  - **Ordering constraint**: `resolveSpawnCommand` can return `shell: true`.
    The prompt is currently an argv element, so landing this before `C001`
    creates a command-injection vector on arbitrary user input.
    **`C001` must land first, or in the same change.**
  - Acceptance: a fresh Windows install with `agy` on PATH starts a turn
    successfully; verified with a unit test in the style of
    `codexLaunchArgs.test.ts`.

- [x] `B003` Conversation continuity across turns
  - Status: `DONE`
  - Severity: `Critical` (feature is misleading as shipped)
  - File: `apps/server/src/provider/Layers/AntigravityAdapter.ts:152`
  - Problem: `--new-project` on *every* turn. Each `sendTurn` spawns a fresh
    process with only the current prompt. No `resumeCursor` on the session
    (contrast `PiAdapter.ts:327`). Turn 2 has no knowledge of turn 1.
  - Fix, in preference order (pick per `I001`):
    1. Use the CLI's native resume flag; store the handle in
       `ProviderSession.resumeCursor` and return it from `sendTurn`.
    2. Send `--new-project` only on the first turn of a session.
    3. Replay prior turns into the prompt (bounded by a token/char budget).
  - Resolution: option 2 — `--new-project` on the first turn of a session,
    `--continue` afterwards. `--print` prints no conversation ID, so option 1
    is not reachable; `--continue` resumes the most recent conversation, which
    is unambiguous because a session's turns are serialized.
  - Depends on: `C002` (turn history is currently never recorded, so option 3
    has no data to replay).
  - Acceptance: a two-turn conversation where turn 2 references turn 1
    ("what did I just ask you?") answers correctly.

---

## Phase 2 — Correctness

- [x] `C001` Move the prompt off the command line
  - Status: `DONE`
  - Severity: `High`
  - File: `AntigravityAdapter.ts:158-159`
  - Problem: Windows caps a command line at ~32 KB — a pasted diff fails at
    spawn with an opaque error. No `--` terminator, so a prompt starting with
    `-` is parsed as a flag.
  - Fix: write the prompt to the child's stdin if `agy` accepts it; otherwise a
    temp file plus `--` before positional args. Prerequisite for `B002`.
  - Resolution (deviates from the plan): neither option exists on this CLI —
    `I001` established there is no stdin input, no `@file` syntax, no positional
    prompt and no `--` terminator. The prompt is now passed as a single
    `--print=<prompt>` argv element, which removes the leading-dash misparse,
    and `sendTurn` rejects prompts over `ANTIGRAVITY_MAX_PROMPT_CHARS` (24k)
    with a `ProviderAdapterValidationError` instead of failing at spawn.
    `resolveSpawnCommand` escapes the argv itself when it returns `shell: true`,
    so `B002` carries no injection risk.

- [x] `C002` Record turn items so `readThread` / `rollbackThread` mean something
  - Status: `DONE`
  - Severity: `High`
  - File: `AntigravityAdapter.ts:273`, `:330`, `:334`
  - Problem: `turns.push({ id, items: [] })` — `items` is never populated.
    `readThread` returns empty turns; `rollbackThread` shuffles empty objects.
  - Fix: mirror `PiAdapter.addItem` (`PiAdapter.ts:89`) — push the assistant
    message item alongside each emitted `item.completed`.

- [x] `C003` Stream stdout incrementally
  - Status: `DONE`
  - Severity: `High`
  - File: `AntigravityAdapter.ts:170-173`
  - Problem: all stdout is buffered via `mkString` and emitted as one
    `content.delta` after exit. UI shows nothing for the whole turn; memory is
    unbounded on a chatty run.
  - Fix: emit `content.delta` per chunk as the stream yields. Also strip ANSI
    escapes / spinner chrome — nothing sanitizes CLI output today, so control
    codes land verbatim in the assistant message.

- [x] `C004` Fix the interrupt race that orphans the child process
  - Status: `DONE`
  - Severity: `High`
  - File: `AntigravityAdapter.ts:283` (fork), `:166` (spawn), `:301` (interrupt)
  - Problem: between `forkDetach` and the spawn resolving, `activeHandle` is
    `undefined`. An interrupt in that window is a no-op on the process, the
    turn reports `state: "interrupted"`, and the CLI keeps running
    unsupervised — with full permission bypass until `B001` lands.
  - Fix: check `context.interrupted` immediately after `spawner.spawn` resolves
    and kill if set; or hold the pending spawn in the context so `interruptTurn`
    can await and kill it.

- [x] `C005` Stop discarding failure detail
  - Status: `DONE`
  - Severity: `Medium`
  - File: `AntigravityAdapter.ts:179`, `:199`
  - Three silent paths:
    - exit 0 + empty stdout → no event at all; turn completes blank.
    - non-zero exit + empty stderr → `runtime.error` skipped *and* stdout was
      already discarded by the `!failed` guard, so the real error text is lost.
      Only the generic "exited with code N" survives.
    - exit 0 + stderr content → warnings dropped.
  - Fix: fall back to stdout for the error message when stderr is empty; emit a
    warning item for stderr on success; emit an explicit empty-response marker.

- [x] `C006` Handle or explicitly reject attachments
  - Status: `DONE`
  - Severity: `Medium`
  - File: `AntigravityAdapter.ts:263`
  - Problem: `input.attachments` is never read, and an attachment-only turn is
    rejected with the misleading "A prompt is required."
  - Note: `PiAdapter.ts:412` is *also* lossy here — it converts images to the
    literal text `[Attached image: name]` and sends no image data, which reads
    as success to the user. Fix both or file a shared follow-up.
  - Resolution: Antigravity rejects attachment-bearing turns with a
    `ProviderAdapterValidationError`; Pi keeps the filename lines but now emits
    a `runtime.warning` naming the attachments whose data was not sent.

- [x] `C007` Probe the binary instead of asserting readiness
  - Status: `DONE`
  - Severity: `Medium`
  - File: `AntigravityDriver.ts:81-84`
  - Problem: `installed: true`, `auth: { status: "authenticated" }`,
    `status: "ready"` are unconditional. With `agy` absent the provider shows
    green and every turn dies at spawn.
  - Fix: use `isCommandAvailable` / the `ClaudeExecutable` toolkit; derive
    `installed` / `status` / `version` from an actual `--version` probe, as
    `GrokProvider.runGrokVersionCommand` does.
  - Resolution (deviates from the plan): `agy` exposes no `--version` flag
    (see `I001`), so the driver resolves availability with `isCommandAvailable`
    — a PATH/PATHEXT lookup, no process spawn — and reports `installed: false`
    / `status: "error"` / `auth: "unknown"` when the binary is missing.
    `version` stays `null`.

- [x] `C008` `customModels` are flagged `isCustom: false`
  - Status: `DONE`
  - Severity: `Low`
  - File: `AntigravityDriver.ts:90`
  - Fix: mark entries originating from `effectiveConfig.customModels` as custom.
  - Related: `PiDriver` accepts a `customModels` setting
    (`packages/contracts/src/settings.ts:379`) and never reads it — dead config.
    Either wire it up or drop it from the schema.

- [x] `C009` Wrap synchronous Pi SDK calls that can throw
  - Status: `DONE`
  - Severity: `Medium`
  - File: `PiAdapter.ts:301` (`SessionManager.open`/`create`), `:296` (`getModel`)
  - Problem: bare sync SDK calls inside `Effect.gen`. Every other SDK call in
    that function is wrapped in `tryPromise` with a typed
    `ProviderAdapterRequestError`. A bad `resumeCursor` path crashes the fiber
    as a defect instead of surfacing an error.

- [x] `C010` `PiAdapter.stop()` leaks on failure
  - Status: `DONE`
  - Severity: `Medium`
  - File: `PiAdapter.ts:453`, `:535`
  - Problem: if `agent.abort()` rejects, `dispose()` never runs and the
    `sessions` entry is never deleted. `stopAll` also fails the entire shutdown
    on the first failing session.
  - Fix: `try`/`finally` (or `Effect.ensuring`) around the teardown; make
    `stopAll` per-session fault-tolerant.

- [x] `C011` Silent wrong-model execution in Pi
  - Status: `DONE`
  - Severity: `Low`
  - File: `PiAdapter.ts:381`
  - Problem: if the requested model isn't found, `if (model)` skips the switch
    and the turn silently runs on the previous model.
  - Fix: fail the turn, or emit a visible warning event.

---

## Phase 3 — Smells and consistency

- [x] `S001` Extract `unsupportedTextGeneration` — copy-pasted verbatim between
      `AntigravityDriver.ts:36` and `PiDriver.ts:39`.
- [x] `S002` Extract the shared adapter helpers `message()` and `now()`,
      duplicated in both adapters; and `joinPath`, duplicated in
      `PiDriver.ts:36` and `PiAdapter.ts:50`.
- [x] `S003` Collapse the toolName→itemType ternary written out **four times**
      in `PiAdapter.handleEvent` (`:126`, `:139`, `:157`, `:177`) into one
      helper. Four places to forget when a tool is added.
- [x] `S004` Unify the two model sources of truth: `ANTIGRAVITY_MODELS`
      (`AntigravityDriver.ts:27`) and `DEFAULT_EFFORT_BY_MODEL`
      (`AntigravityAdapter.ts:37`) live in different files. Adding a model to
      one silently defaults the other to `"Medium"`. Also reconcile
      `DEFAULT_MODEL = "Gemini 3.5 Flash"` (`AntigravityAdapter.ts:30`) with the
      driver listing `"Gemini 3.6 Flash"` first — the default is the older model.
- [x] `S005` Tighten `resolveCliModel` (`AntigravityAdapter.ts:46`). The regex
      `/\([^()]+\)\s*$/` treats *any* trailing parenthesised text as an effort
      suffix, so a custom model `"Foo (Preview)"` passes through unsuffixed and
      is rejected by the CLI. Match against the known effort vocabulary instead.
- [x] `S006` One slug parser for Pi: `PiAdapter.ts:294` uses `split`/`join`,
      `:378` uses `indexOf`/`slice`. Same format, two implementations, ~80 lines
      apart.
- [x] `S007` Delete the dead branch at `PiAdapter.ts:194` —
      `if (event.type === "agent_end" && …) { return; }` is a no-op that reads
      as if it does something (the next check requires `agent_settled`).
- [x] `S008` Make `emit()` type-safe and supervised
      (`AntigravityAdapter.ts:86`, `PiAdapter.ts:74`):
      `void Effect.runPromise(...)` with no `.catch()`, and the payload is cast
      `as ProviderRuntimeEvent` from `Record<string, unknown>` — the contract
      types provide zero protection on the hottest path in the file. Same class
      of issue at `PiAdapter.ts:416`, where the prompt promise runs outside
      fiber supervision and won't be interrupted on shutdown.
      *(Pre-existing in Pi; Antigravity inherited it. Fix in both.)*
- [x] `S009` Reuse Pi's exported, tested `rollbackTurns`
      (`PiAdapter.ts:53`) in `AntigravityAdapter.ts:334`, which silently clamps
      garbage input where Pi returns a `ProviderAdapterValidationError`.
- [x] `S010` Correct the capabilities declaration
      (`AntigravityAdapter.ts:298`): `sessionModelSwitch: "unsupported"`, yet
      `sendTurn` honours `input.modelSelection.model` on every turn (`:274`).
      Since each turn is a new process, per-turn switching is free — the
      declaration is simply wrong.

`S008` note: making `emit` typed immediately surfaced a live bug —
`PiAdapter` emitted `cumulativeCostUsd`, which is not a field of
`TurnCompletedPayload`. The turn cost was therefore never reaching consumers.
Renamed to `totalCostUsd`, matching `ClaudeAdapter`.

### Deferred (shared, pre-existing — file separately if not done here)

- Unbounded growth: `context.turns` and the `sessions` map are never trimmed in
  either adapter; a long-lived session accumulates turn records forever.
- Start race: both `startSession` implementations do check-then-set on
  `sessions` with no lock. Two concurrent starts for one `threadId` both create
  a session; the second wins and the first leaks — with a live subscription, in
  Pi's case.

---

## Phase 4 — Tests

- [x] `T001` Add `AntigravityDriver.test.ts` and `AntigravityAdapter.test.ts`
  - Status: `DONE`
  - Problem: both files ship with **zero** tests. Every other driver and adapter
    in those directories has one — Claude, Codex, Cursor, Grok, OpenCode, Pi,
    plus focused suites for `codexLaunchArgs` and `CodexHomeLayout`.
  - Minimum coverage:
    - `resolveCliModel` — bare name, already-suffixed, unknown model,
      `"Foo (Preview)"` false positive (`S005`).
    - Argv construction per `runtimeMode` (`B001`) and per platform (`B002`).
    - `runTurn` exit-code → event mapping across all four cases in `C005`.
    - Interrupt-before-spawn (`C004`).
    - `rollbackTurns` reuse (`S009`) — pattern already established by
      `PiAdapter`'s exported helper.

---

## Suggested landing order

1. `I001`, `I002` (investigation — unblocks everything)
2. `C001` → `B002` (must be same change or this order; injection risk)
3. `B001` (security)
4. `C002` → `B003` (continuity needs turn history first)
5. `C007`, `C005`, `C004`, `C003` (user-visible correctness)
6. `T001` alongside each of the above, not after
7. Phase 3 smells — safe to batch once the above are green
