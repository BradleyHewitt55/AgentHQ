import type { Task } from "@t3tools/contracts";
import { KanbanSquare, PlayIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "~/lib/utils";
import type { ProjectTasksView } from "~/state/taskActions";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { TaskComposer } from "./TaskComposer";
import { countTasksByStatus, selectRunningTasks, taskIssueLabel } from "./taskPresentation";

interface TasksQuickActionProps {
  view: ProjectTasksView;
  /** Hands the task to an agent in this project. */
  onPassToAgent?: (task: Task) => void;
  /** Opens the full kanban in the right panel. */
  onOpenBoard?: () => void;
}

function QuickTaskRow(props: { task: Task; onPassToAgent?: (task: Task) => void }) {
  const issueLabel = taskIssueLabel(props.task);
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <span className="min-w-0 flex-1 truncate text-sm">{props.task.title}</span>
      {issueLabel !== null && (
        <span className="shrink-0 text-[10px] text-muted-foreground">{issueLabel}</span>
      )}
      {props.onPassToAgent && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => props.onPassToAgent?.(props.task)}
          aria-label={`Pass "${props.task.title}" to agent`}
        >
          <PlayIcon className="size-3.5" />
        </Button>
      )}
    </li>
  );
}

/**
 * Top-bar quick action: shows tasks an agent is currently running, the next
 * few queued tasks, and an inline composer for adding a draft or an issue.
 */
export function TasksQuickAction(props: TasksQuickActionProps) {
  const { view } = props;
  const [open, setOpen] = useState(false);

  const running = selectRunningTasks(view.tasks);
  const counts = countTasksByStatus(view.tasks);
  const queued = view.tasks.filter((task) => task.status === "todo").slice(0, 5);

  const handleCreated = useCallback(() => {
    // Keep the popover open so several tasks can be added in a row.
    view.refresh();
  }, [view]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs" aria-label="Tasks">
            <KanbanSquare className="size-3.5" />
            <span className="max-md:sr-only">Tasks</span>
            {running.length > 0 && (
              <Badge
                variant="secondary"
                className={cn("h-4 min-w-4 px-1 text-[10px] tabular-nums")}
              >
                {running.length}
              </Badge>
            )}
          </Button>
        }
      />
      <PopoverPopup align="start" className="w-80 p-0">
        <div className="border-b border-border/60 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Running
            </h3>
            {props.onOpenBoard && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => {
                  setOpen(false);
                  props.onOpenBoard?.();
                }}
              >
                Open board
              </Button>
            )}
          </div>
          {running.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">No tasks in progress.</p>
          ) : (
            <ScrollArea className="max-h-40">
              <ul className="py-0.5">
                {running.map((task) => (
                  <QuickTaskRow
                    key={task.taskId}
                    task={task}
                    {...(props.onPassToAgent ? { onPassToAgent: props.onPassToAgent } : {})}
                  />
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>

        {queued.length > 0 && (
          <div className="border-b border-border/60 px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Todo
              <span className="ml-1.5 font-normal text-muted-foreground/70">{counts.todo}</span>
            </h3>
            <ul className="py-0.5">
              {queued.map((task) => (
                <QuickTaskRow
                  key={task.taskId}
                  task={task}
                  {...(props.onPassToAgent ? { onPassToAgent: props.onPassToAgent } : {})}
                />
              ))}
            </ul>
          </div>
        )}

        <div className="px-3 py-2">
          <TaskComposer view={view} onCreated={handleCreated} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
