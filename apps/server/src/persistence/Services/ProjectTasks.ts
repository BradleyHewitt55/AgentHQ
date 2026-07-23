/**
 * ProjectTaskRepository - Persistence interface for project-scoped tasks.
 *
 * Tasks are authored locally and stored in SQLite regardless of whether the
 * project has a linked repository, so this repository is the source of truth.
 * GitHub linkage is carried on the row and reconciled by the sync service.
 *
 * @module ProjectTaskRepository
 */
import { ProjectId, Task, TaskId, TaskStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ListProjectTasksInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectTasksInput = typeof ListProjectTasksInput.Type;

/**
 * Task ids are globally unique, but every read is still project-scoped so a
 * caller cannot reach a task belonging to another project.
 */
export const GetProjectTaskInput = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
});
export type GetProjectTaskInput = typeof GetProjectTaskInput.Type;

export const DeleteProjectTaskInput = Schema.Struct({
  taskId: TaskId,
  projectId: ProjectId,
});
export type DeleteProjectTaskInput = typeof DeleteProjectTaskInput.Type;

export const DeleteProjectTasksByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteProjectTasksByProjectInput = typeof DeleteProjectTasksByProjectInput.Type;

export const NextProjectTaskPositionInput = Schema.Struct({
  projectId: ProjectId,
  status: TaskStatus,
});
export type NextProjectTaskPositionInput = typeof NextProjectTaskPositionInput.Type;

/**
 * ProjectTaskRepositoryShape - Service API for project task rows.
 */
export interface ProjectTaskRepositoryShape {
  /**
   * Insert or replace a task row, keyed by `taskId`.
   *
   * The GitHub link is persisted as JSON so the column stays stable as the
   * link gains fields.
   */
  readonly upsert: (row: Task) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a single task row owned by a project.
   */
  readonly getById: (
    input: GetProjectTaskInput,
  ) => Effect.Effect<Option.Option<Task>, ProjectionRepositoryError>;

  /**
   * List a project's tasks in board order: column, then manual position, then
   * creation time as a stable tiebreak.
   */
  readonly listByProject: (
    input: ListProjectTasksInput,
  ) => Effect.Effect<ReadonlyArray<Task>, ProjectionRepositoryError>;

  /**
   * Hard-delete a task row owned by a project.
   */
  readonly deleteById: (
    input: DeleteProjectTaskInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Hard-delete every task row of a project, used when the project itself is
   * deleted so tasks do not outlive it.
   */
  readonly deleteByProject: (
    input: DeleteProjectTasksByProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Next free append position at the end of a column.
   */
  readonly nextPosition: (
    input: NextProjectTaskPositionInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
}

/**
 * ProjectTaskRepository - Service tag for project task persistence.
 */
export class ProjectTaskRepository extends Context.Service<
  ProjectTaskRepository,
  ProjectTaskRepositoryShape
>()("t3/persistence/Services/ProjectTasks/ProjectTaskRepository") {}
