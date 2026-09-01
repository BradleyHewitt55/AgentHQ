/**
 * React surface for project tasks.
 *
 * Tasks come straight from a GitHub Projects v2 board, which pushes nothing,
 * so the list is a query that refetches after every mutation instead of a
 * server-driven subscription.
 */
import type {
  EnvironmentId,
  ProjectId,
  Task,
  TaskCreatableKind,
  TaskProjectRef,
  TaskStatus,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useEnvironmentQuery } from "./query";
import { taskEnvironment } from "./tasks";
import { useAtomCommand } from "./use-atom-command";
import { vcsEnvironment } from "./vcs";

export interface ProjectTaskScope {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  /** Workspace root; anchors `gh` auth, repository lookups, and issue creation. */
  readonly cwd: string | null;
}

const EMPTY_TASKS: ReadonlyArray<Task> = [];
const EMPTY_PROJECTS: ReadonlyArray<TaskProjectRef> = [];

export function useProjectTasks(scope: ProjectTaskScope) {
  const listAtom =
    scope.environmentId !== null && scope.projectId !== null && scope.cwd !== null
      ? taskEnvironment.list({
          environmentId: scope.environmentId,
          input: { projectId: scope.projectId, cwd: scope.cwd },
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

  const { refresh } = query;
  const { environmentId, projectId, cwd } = scope;

  const status = repositoryStatus.data;
  const canUseGitHub =
    cwd !== null &&
    status !== null &&
    status.isRepo &&
    status.hasPrimaryRemote &&
    status.sourceControlProvider?.kind === "github";

  const [isMutating, setMutating] = useState(false);
  // The hook lives in a view that survives a project switch; drop a stale
  // mutation flag when the scope moves on.
  useEffect(() => setMutating(false), [projectId]);

  const track = useCallback(
    async <A>(run: () => Promise<A>): Promise<A> => {
      setMutating(true);
      try {
        return await run();
      } finally {
        setMutating(false);
        // GitHub pushes nothing, so every mutation refetches the board.
        refresh();
      }
    },
    [refresh],
  );

  const createTask = useCallback(
    (input: { title: string; body?: string; kind: TaskCreatableKind }) => {
      if (environmentId === null || projectId === null || cwd === null) {
        return Promise.resolve(null);
      }
      return track(() =>
        runCreate({
          environmentId,
          input: {
            projectId,
            cwd,
            title: input.title,
            ...(input.body === undefined ? {} : { body: input.body }),
            kind: input.kind,
          },
        }),
      );
    },
    [cwd, environmentId, projectId, runCreate, track],
  );

  const updateTaskStatus = useCallback(
    (taskId: Task["taskId"], status: TaskStatus) => {
      if (environmentId === null || projectId === null || cwd === null) {
        return Promise.resolve(null);
      }
      return track(() => runUpdate({ environmentId, input: { taskId, projectId, cwd, status } }));
    },
    [cwd, environmentId, projectId, runUpdate, track],
  );

  const deleteTask = useCallback(
    (taskId: Task["taskId"]) => {
      if (environmentId === null || projectId === null || cwd === null) {
        return Promise.resolve(null);
      }
      return track(() => runRemove({ environmentId, input: { taskId, projectId, cwd } }));
    },
    [cwd, environmentId, projectId, runRemove, track],
  );

  const promoteTask = useCallback(
    (taskId: Task["taskId"]) => {
      if (environmentId === null || projectId === null || cwd === null) {
        return Promise.resolve(null);
      }
      return track(() => runPromote({ environmentId, input: { taskId, projectId, cwd } }));
    },
    [cwd, environmentId, projectId, runPromote, track],
  );

  const tasks = query.data?.tasks ?? EMPTY_TASKS;
  const project = query.data?.project ?? null;
  const projects = query.data?.projects ?? EMPTY_PROJECTS;

  return useMemo(
    () => ({
      tasks,
      project,
      projects,
      error: query.error,
      isPending: query.isPending,
      isMutating,
      /** True when GitHub-backed actions (issue creation, promote) can run. */
      canUseGitHub,
      refresh,
      createTask,
      updateTaskStatus,
      deleteTask,
      promoteTask,
    }),
    [
      canUseGitHub,
      createTask,
      deleteTask,
      isMutating,
      project,
      projects,
      promoteTask,
      query.error,
      query.isPending,
      refresh,
      tasks,
      updateTaskStatus,
    ],
  );
}

export type ProjectTasksView = ReturnType<typeof useProjectTasks>;

/** Group tasks into kanban columns, preserving the fetch order inside each. */
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
