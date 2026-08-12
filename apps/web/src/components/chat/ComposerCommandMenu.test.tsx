import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";

const claude = ProviderDriverKind.make("claudeAgent");
const claudeWork = ProviderInstanceId.make("claude_work");

const builtInItem: ComposerCommandItem = {
  id: "slash:model",
  type: "slash-command",
  command: "model",
  label: "/model",
  description: "Switch response model for this thread",
};

const providerItem: ComposerCommandItem = {
  id: "provider-slash-command:claude_work:review",
  type: "provider-slash-command",
  provider: claude,
  providerInstanceId: claudeWork,
  command: {
    name: "review",
    description: "Review the current changes",
    input: { hint: "[focus]" },
  },
  label: "/review",
  description: "Review the current changes",
};

function renderMenu(input: {
  items: ComposerCommandItem[];
  state?: "available" | "loading" | "unavailable";
  isFiltered?: boolean;
}) {
  return renderToStaticMarkup(
    <ComposerCommandMenu
      items={input.items}
      resolvedTheme="dark"
      isLoading={input.state === "loading"}
      triggerKind="slash-command"
      groupSlashCommandSections
      {...(input.state
        ? {
            slashCommandProvider: {
              label: "Claude Work",
              state: input.state,
              isFiltered: input.isFiltered ?? false,
            },
          }
        : {})}
      activeItemId={providerItem.id}
      onHighlightedItemChange={() => {}}
      onSelect={() => {}}
    />,
  );
}

describe("ComposerCommandMenu slash commands", () => {
  it("groups built-ins separately from the selected provider instance and exposes input hints", () => {
    const html = renderMenu({ items: [builtInItem, providerItem], state: "available" });

    expect(html).toContain("Built-in");
    expect(html).toContain("Claude Work");
    expect(html).toContain("/review");
    expect(html).toContain("[focus]");
    expect(html).toContain('aria-label="/review: Review the current changes"');
  });

  it("keeps built-ins visible while clearly reporting provider command discovery states", () => {
    const loading = renderMenu({ items: [builtInItem], state: "loading" });
    const unavailable = renderMenu({ items: [builtInItem], state: "unavailable" });
    const empty = renderMenu({ items: [builtInItem], state: "available" });

    expect(loading).toContain("Loading Claude Work commands…");
    expect(unavailable).toContain("Claude Work is unavailable.");
    expect(empty).toContain("Claude Work exposes no slash commands.");
    expect(loading).toContain('role="status"');
  });
});
