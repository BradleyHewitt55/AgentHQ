import { PlusIcon } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";

import type { ProjectTasksView } from "~/state/taskActions";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { taskCommandSucceeded } from "./taskPresentation";

interface TaskComposerProps {
  view: ProjectTasksView;
  onCreated?: () => void;
}

/**
 * Inline "add a task" control. Creating a draft is always available; creating
 * an issue requires a linked GitHub repository and pushes immediately.
 */
export function TaskComposer(props: TaskComposerProps) {
  const { view } = props;
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (kind: "draft" | "issue") => {
      const trimmed = title.trim();
      if (trimmed === "" || busy) return;
      setBusy(true);
      try {
        const result = await view.createTask({ title: trimmed, kind });
        // Keep the typed title when creation failed so it can be retried.
        if (!taskCommandSucceeded(result)) return;
        setTitle("");
        props.onCreated?.();
      } finally {
        setBusy(false);
      }
    },
    [busy, props, title, view],
  );

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void submit("draft");
    },
    [submit],
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Add a task…"
        aria-label="Task title"
        className="h-8 text-sm"
      />
      <div className="flex items-center gap-1.5">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={busy || title.trim() === ""}
          className="h-7 gap-1 text-xs"
        >
          <PlusIcon className="size-3.5" />
          Draft
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          // Without a linked repository there is nowhere to file the issue.
          disabled={busy || title.trim() === "" || !view.canUseGitHub}
          onClick={() => void submit("issue")}
          className="h-7 gap-1 text-xs"
          title={
            view.canUseGitHub
              ? "Create a GitHub issue for this task"
              : "Link a GitHub repository to create issues"
          }
        >
          <PlusIcon className="size-3.5" />
          Issue
        </Button>
      </div>
    </form>
  );
}
