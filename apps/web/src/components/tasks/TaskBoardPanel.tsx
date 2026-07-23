import type { Task, TaskStatus } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  GitPullRequestArrowIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useState } from "react";

import { cn } from "~/lib/utils";
import type { ProjectTasksView } from "~/state/taskActions";
import { groupTasksByStatus } from "~/state/taskActions";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TaskComposer } from "./TaskComposer";
import {
  TASK_BOARD_COLUMNS,
  TASK_STATUS_LABELS,
  canPromoteTask,
  isTaskStatus,
  taskIssueLabel,
} from "./taskPresentation";

interface TaskBoardPanelProps {
  view: ProjectTasksView;
  /** Hands the task to an agent in this project; absent when no chat is available. */
  onPassToAgent?: (task: Task) => void;
}

function TaskCard(props: {
  task: Task;
  view: ProjectTasksView;
  onPassToAgent?: (task: Task) => void;
}) {
  const { task, view } = props;
  const issueLabel = taskIssueLabel(task);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }, []);

  const handlePassToAgent = useCallback(() => {
    props.onPassToAgent?.(task);
  }, [props, task]);

  const handleStatusChange = useCallback(
    (value: unknown) => {
      if (!isTaskStatus(value) || value === task.status) return;
      void run(() =>
        view.updateTask(task.taskId, {
          status: value,
          // A linked issue mirrors the column move; a draft has nothing to push.
          pushToGitHub: task.github !== null,
        }),
      );
    },
    [run, task.github, task.status, task.taskId, view],
  );

  return (
    <div className="rounded-md border border-border/60 bg-card p-2.5 text-sm shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium leading-snug">{task.title}</span>
        {issueLabel === null ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            Draft
          </Badge>
        ) : (
          <a
            href={task.github?.issueUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[10px] text-muted-foreground hover:underline"
          >
            {issueLabel}
          </a>
        )}
      </div>

      {task.body.trim() !== "" && (
        <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{task.body}</p>
      )}

      <div className="mt-2 flex items-center gap-1">
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                aria-label={`Move "${task.title}" to another column`}
              />
            }
          >
            {TASK_STATUS_LABELS[task.status]}
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuRadioGroup value={task.status} onValueChange={handleStatusChange}>
              {TASK_BOARD_COLUMNS.map((column) => (
                <MenuRadioItem key={column.status} value={column.status}>
                  {column.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>

        {props.onPassToAgent && task.status !== "done" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={handlePassToAgent}
                  aria-label="Pass to agent"
                >
                  <PlayIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="top">Pass to agent</TooltipPopup>
          </Tooltip>
        )}

        {canPromoteTask(task) && view.canUseGitHub && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() => void run(() => view.promoteTask(task.taskId))}
                  aria-label="Create GitHub issue"
                >
                  <GitPullRequestArrowIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="top">Create GitHub issue</TooltipPopup>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                onClick={() => void run(() => view.deleteTask(task.taskId))}
                aria-label="Delete task"
                className="ml-auto text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup side="top">Delete task</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function TaskColumn(props: {
  status: TaskStatus;
  label: string;
  tasks: ReadonlyArray<Task>;
  view: ProjectTasksView;
  onPassToAgent?: (task: Task) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <header className="flex items-center gap-2 px-0.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {props.label}
        </h3>
        <span className="text-xs text-muted-foreground/70">{props.tasks.length}</span>
      </header>
      <div className="flex flex-col gap-2">
        {props.tasks.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/50 px-2.5 py-3 text-xs text-muted-foreground">
            Nothing here yet.
          </p>
        ) : (
          props.tasks.map((task) => (
            <TaskCard
              key={task.taskId}
              task={task}
              view={props.view}
              {...(props.onPassToAgent ? { onPassToAgent: props.onPassToAgent } : {})}
            />
          ))
        )}
      </div>
    </section>
  );
}

/**
 * Kanban view of a project's tasks. Columns mirror {@link TaskStatus}; the
 * server keeps ordering within a column.
 */
export const TaskBoardPanel = memo(function TaskBoardPanel(props: TaskBoardPanelProps) {
  const { view } = props;
  const columns = groupTasksByStatus(view.tasks);
  const [syncing, setSyncing] = useState(false);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await view.syncTasks();
    } finally {
      setSyncing(false);
    }
  }, [view]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-sm font-semibold">Tasks</h2>
        {view.canUseGitHub && (
          <Button
            variant="ghost"
            size="sm"
            disabled={syncing}
            onClick={() => void handleSync()}
            className="gap-1.5 text-xs"
          >
            <RefreshCwIcon className={cn("size-3.5", syncing && "animate-spin")} />
            Sync
          </Button>
        )}
      </div>

      <div className="border-b border-border/60 px-3 py-2">
        <TaskComposer view={view} />
      </div>

      {view.error !== null && <p className="px-3 py-2 text-xs text-destructive">{view.error}</p>}

      {view.boardUnavailable && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Issues are linked, but no GitHub Projects board could be updated, so board columns are
          local only.
        </p>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {TASK_BOARD_COLUMNS.map((column) => (
            <TaskColumn
              key={column.status}
              status={column.status}
              label={column.label}
              tasks={columns[column.status]}
              view={view}
              {...(props.onPassToAgent ? { onPassToAgent: props.onPassToAgent } : {})}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
});
