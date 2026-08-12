import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentsPanel } from "./AgentsPanel";

function activity(kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: `event-${kind}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as OrchestrationThreadActivity;
}

describe("AgentsPanel file details", () => {
  it("renders each agent as an accessible file-details button", () => {
    const model = deriveAgentPanelModel({
      agents: foldSubagentActivities([
        activity("task.started", {
          taskId: "files-agent",
          agentKind: "agent",
          title: "Implement panel",
          activeFiles: ["apps/web/src/components/AgentsPanel.tsx"],
          changedFiles: ["packages/client-runtime/src/state/subagentRuntime.ts"],
        }),
      ]),
    });

    const markup = renderToStaticMarkup(<AgentsPanel model={model} />);

    expect(markup).toContain('aria-label="Show files for Implement panel"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="_R_');
    // Paths are disclosure content, rather than visual noise in the roster.
    expect(markup).not.toContain("apps/web/src/components/AgentsPanel.tsx");
  });
});
