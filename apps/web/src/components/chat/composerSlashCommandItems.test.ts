import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerSlashCommandItems } from "./composerSlashCommandItems";

const claude = ProviderDriverKind.make("claudeAgent");

function itemsFor(instanceId: string, names: string[]) {
  return providerSlashCommandItems({
    instanceId: ProviderInstanceId.make(instanceId),
    provider: claude,
    slashCommands: names.map((name) => ({ name })),
  });
}

describe("providerSlashCommandItems", () => {
  it("creates rows exclusively from the selected provider instance snapshot", () => {
    const personal = itemsFor("claude_personal", ["personal-review"]);
    const work = itemsFor("claude_work", ["work-review"]);

    expect(personal.map((item) => item.label)).toEqual(["/personal-review"]);
    expect(work.map((item) => item.label)).toEqual(["/work-review"]);
    expect(work[0]?.id).toBe("provider-slash-command:claude_work:work-review");
  });

  it("rebuilds rows from a live replacement snapshot without retaining prior commands", () => {
    const initial = itemsFor("claude_work", ["review", "release"]);
    const refreshed = itemsFor("claude_work", ["deploy"]);

    expect(initial.map((item) => item.label)).toEqual(["/review", "/release"]);
    expect(refreshed.map((item) => item.label)).toEqual(["/deploy"]);
  });
});
