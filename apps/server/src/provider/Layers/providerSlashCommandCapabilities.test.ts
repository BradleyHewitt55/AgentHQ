import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePendingCodexProvider } from "./CodexProvider.ts";
import { buildInitialCursorProviderSnapshot } from "./CursorProvider.ts";
import { buildInitialGrokProviderSnapshot } from "./GrokProvider.ts";
import { makePendingOpenCodeProvider } from "./OpenCodeProvider.ts";

it.effect("keeps providers without a command-discovery protocol explicitly empty", () =>
  Effect.gen(function* () {
    // Codex app-server and the Cursor/Grok ACP initialization flow expose no
    // slash-command catalog. OpenCode's SDK inventory has the same limit.
    const snapshots = yield* Effect.all([
      makePendingCodexProvider(DEFAULT_SERVER_SETTINGS.providers.codex),
      buildInitialCursorProviderSnapshot(DEFAULT_SERVER_SETTINGS.providers.cursor),
      buildInitialGrokProviderSnapshot(DEFAULT_SERVER_SETTINGS.providers.grok),
      makePendingOpenCodeProvider(DEFAULT_SERVER_SETTINGS.providers.opencode),
    ]);

    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.slashCommands),
      [[], [], [], []],
    );
  }),
);
