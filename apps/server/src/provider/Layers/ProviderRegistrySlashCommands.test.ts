import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { mergeProviderSnapshots } from "./ProviderRegistry.ts";

const claudeDriver = ProviderDriverKind.make("claudeAgent");

const makeProvider = (
  instanceId: string,
  slashCommands: ServerProvider["slashCommands"],
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: claudeDriver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands,
  skills: [],
});

it("updates slash commands only for the emitting provider instance", () => {
  const personal = makeProvider("claude_personal", [{ name: "review" }]);
  const work = makeProvider("claude_work", [{ name: "deploy" }]);
  const refreshedPersonal = makeProvider("claude_personal", [{ name: "ui" }]);

  expect(mergeProviderSnapshots([personal, work], [refreshedPersonal])).toEqual([
    refreshedPersonal,
    work,
  ]);
});
