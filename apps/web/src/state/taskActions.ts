/**
 * React surface for project tasks.
 *
 * Wraps the task RPC atoms so components deal in plain tasks and callbacks.
 * Every mutation refreshes the project's list atom, which keeps the top-bar
 * quick action and the kanban panel showing the same rows.
 */
import type {
  EnvironmentId,
  ProjectId,
  Task,
  TaskKind,
  TaskStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useEnvironmentQuery } from "./query";
import { taskEnvironment } from "./tasks";
import { useAtomCommand } from "./use-atom-command";
import { vcsEnvironment } from "./vcs";

export interface ProjectTaskScope {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  /** Workspace root, required for anything that reaches GitHub. */
  readonly cwd: string | null;
}

const EMPTY_TASKS: ReadonlyArray<Task> = [];

export function useProjectTasks(scope: ProjectTaskScope) {
  const listAtom =
    scope.environmentId !== null && scope.projectId !== null
      ? taskEnvironment.list({
          environmentId: scope.environmentId,
          input: { projectId: scope.projectId },
        })
      : null;

  const query = useEnvironmentQuery(listAtom);
  // The same status the rest of the app reads to decide whether source control
  // actions apply; a workspace directory alone says nothing about a remote.
  const repositoryStatus = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const runCreate = useAtomCommand(taskEnvironment.create);
  const runUpdate = useAtomCommand(taskEnvironment.update);
  const runRemove = useAtomCommand(taskEnvironment.remove);
  const runPromote = useAtomCommand(taskEnvironment.promote);
  const runSync = useAtomCommand(taskEnvironment.sync);

  const { refresh } = query;
  const { environmentId, projectId, cwd } = scope;

  const status = repositoryStatus.data;
  const canUseGitHub =
    cwd !== null &&
    status !== null &&
    status.isRepo &&
    status.hasPrimaryRemote &&
    status.sourceControlProvider?.kind === "github";

  const [boardUnavailable, setBoardUnavailable] = useState(false);
  // The hook lives in a view that survives a project switch, so a warning
  // raised for one project must not follow the user into the next one.
  useEffect(() => setBoardUnavailable(false), [projectId]);

  /**
   * A push can link the issue yet fail to place it on the Projects v2 board;
   * the last GitHub-touching mutation decides what the board panel warns about.
   */
  const noteBoardOutcome = useCallback(
    (result: AsyncResult.AsyncResult<{ readonly boardUnavailable: boolean }, unknown>) => {
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) {
        setBoardUnavailable(value.boardUnavailable);
      }
    },
    [],
  );

  const createTask = useCallback(
    async (input: { title: string; body?: string; kind: TaskKind; status?: TaskStatus }) => {
      if (environmentId === null || projectId === null) return null;
      const result = await runCreate({
        environmentId,
        input: {
          projectId,
          title: input.title,
          ...(input.body === undefined ? {} : { body: input.body }),
          kind: input.kind,
          ...(input.status === undefined ? {} : { status: input.status }),
          // Creating an `issue` needs a GitHub repository to file it in;
          // without one the server stores a promotable draft instead.
          ...(input.kind === "issue" && canUseGitHub && cwd !== null ? { cwd } : {}),
        },
      });
      noteBoardOutcome(result);
      refresh();
      return result;
    },
    [canUseGitHub, cwd, environmentId, noteBoardOutcome, projectId, refresh, runCreate],
  );

  const updateTask = useCallback(
    async (
      taskId: Task["taskId"],
      changes: {
        title?: string;
        body?: string;
        status?: TaskStatus;
        position?: number;
        threadId?: ThreadId | null;
        pushToGitHub?: boolean;
      },
    ) => {
      if (environmentId === null || projectId === null) return null;
      const result = await runUpdate({
        environmentId,
        input: {
          taskId,
          projectId,
          ...changes,
          ...(changes.pushToGitHub === true && cwd !== null ? { cwd } : {}),
        },
      });
      noteBoardOutcome(result);
      refresh();
      return result;
    },
    [cwd, environmentId, noteBoardOutcome, projectId, refresh, runUpdate],
  );

  const deleteTask = useCallback(
    async (taskId: Task["taskId"]) => {
      if (environmentId === null || projectId === null) return null;
      const result = await runRemove({ environmentId, input: { taskId, projectId } });
      refresh();
      return result;
    },
    [environmentId, projectId, refresh, runRemove],
  );

  const promoteTask = useCallback(
    async (taskId: Task["taskId"]) => {
      if (environmentId === null || projectId === null || cwd === null) return null;
      const result = await runPromote({ environmentId, input: { taskId, projectId, cwd } });
      noteBoardOutcome(result);
      refresh();
      return result;
    },
    [cwd, environmentId, noteBoardOutcome, projectId, refresh, runPromote],
  );

  const syncTasks = useCallback(async () => {
    if (environmentId === null || projectId === null || cwd === null) return null;
    const result = await runSync({ environmentId, input: { projectId, cwd } });
    noteBoardOutcome(result);
    refresh();
    return result;
  }, [cwd, environmentId, noteBoardOutcome, projectId, refresh, runSync]);

  const tasks = query.data?.tasks ?? EMPTY_TASKS;

  return useMemo(
    () => ({
      tasks,
      error: query.error,
      isPending: query.isPending,
      /** True when GitHub-backed actions (promote, sync) can run. */
      canUseGitHub,
      /** True when the last GitHub push could not place the issue on a board. */
      boardUnavailable,
      refresh,
      createTask,
      updateTask,
      deleteTask,
      promoteTask,
      syncTasks,
    }),
    [
      boardUnavailable,
      canUseGitHub,
      createTask,
      deleteTask,
      promoteTask,
      query.error,
      query.isPending,
      refresh,
      syncTasks,
      tasks,
      updateTask,
    ],
  );
}

export type ProjectTasksView = ReturnType<typeof useProjectTasks>;

/** Group tasks into kanban columns, preserving the server's board ordering. */
export function groupTasksByStatus(
  tasks: ReadonlyArray<Task>,
): Record<TaskStatus, ReadonlyArray<Task>> {
  const columns: Record<TaskStatus, Task[]> = {
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
  };
  for (const task of tasks) {
    columns[task.status].push(task);
  }
  return columns;
}
