import { AlignLeftIcon, PlusIcon } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";

import type { ProjectTasksView } from "~/state/taskActions";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { taskCommandSucceeded } from "./taskPresentation";

interface TaskComposerProps {
  view: ProjectTasksView;
  onCreated?: () => void;
}

/**
 * Inline "add a task" control. Tasks mirror GitHub Projects items, so a title
 * plus optional description are sent; drafts are always available while issues
 * require a linked GitHub repository.
 */
export function TaskComposer(props: TaskComposerProps) {
  const { view } = props;
  const hasProject = view.project !== null || view.projects.length > 0;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [showBody, setShowBody] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (kind: "draft" | "issue") => {
      const trimmed = title.trim();
      const trimmedBody = body.trim();
      if (trimmed === "" || busy) return;
      setBusy(true);
      try {
        const result = await view.createTask({
          title: trimmed,
          ...(trimmedBody === "" ? {} : { body: trimmedBody }),
          kind,
        });
        // Keep the typed text when creation failed so it can be retried.
        if (!taskCommandSucceeded(result)) return;
        setTitle("");
        setBody("");
        setShowBody(false);
        props.onCreated?.();
      } finally {
        setBusy(false);
      }
    },
    [body, busy, props, title, view],
  );

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void submit("draft");
    },
    [submit],
  );

  // When no GitHub Projects v2 board is linked to the workspace's repository
  // there is nowhere to create a task; the panel shows "No project located"
  // and the composer is disabled.
  const noProjectReason = !hasProject
    ? "No GitHub Projects board is linked to this repository"
    : null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={hasProject ? "Add a task…" : "No project located — link a board on GitHub"}
        aria-label="Task title"
        className="h-8 text-sm"
        disabled={!hasProject}
        title={noProjectReason ?? undefined}
      />
      {showBody ? (
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add a description…"
          aria-label="Task description"
          rows={3}
          className="text-sm"
          disabled={!hasProject}
        />
      ) : null}
      <div className="flex items-center gap-1.5">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || title.trim() === "" || !hasProject}
          className="h-7 gap-1 text-xs"
          title={noProjectReason ?? undefined}
        >
          <PlusIcon className="size-3.5" />
          Draft
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          // Without a linked repository or project there is nowhere to file the issue.
          disabled={busy || title.trim() === "" || !view.canUseGitHub || !hasProject}
          onClick={() => void submit("issue")}
          className="h-7 gap-1 text-xs"
          title={
            !hasProject
              ? (noProjectReason ?? "No project")
              : view.canUseGitHub
                ? "Create a GitHub issue for this task"
                : "Link a GitHub repository to create issues"
          }
        >
          <PlusIcon className="size-3.5" />
          Issue
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || !hasProject}
          onClick={() => setShowBody((open) => !open)}
          aria-pressed={showBody}
          className="ml-auto h-7 gap-1 px-1.5 text-xs text-muted-foreground"
          title={
            !hasProject
              ? (noProjectReason ?? "No project")
              : showBody
                ? "Hide description"
                : "Add a description"
          }
        >
          <AlignLeftIcon className="size-3.5" />
          Description
        </Button>
      </div>
    </form>
  );
}
