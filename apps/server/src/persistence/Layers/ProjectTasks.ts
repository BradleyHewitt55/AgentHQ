import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { Task, TaskGitHubLink } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectTaskInput,
  DeleteProjectTasksByProjectInput,
  GetProjectTaskInput,
  ListProjectTasksInput,
  NextProjectTaskPositionInput,
  ProjectTaskRepository,
  type ProjectTaskRepositoryShape,
} from "../Services/ProjectTasks.ts";

const ProjectTaskDbRow = Task.mapFields(
  Struct.assign({
    github: Schema.NullOr(Schema.fromJsonString(TaskGitHubLink)),
  }),
);
type ProjectTaskDbRow = typeof ProjectTaskDbRow.Type;

const NextPositionRow = Schema.Struct({
  nextPosition: Schema.Number,
});

const makeProjectTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectTaskRow = SqlSchema.void({
    Request: Task,
    execute: (row) =>
      sql`
        INSERT INTO project_tasks (
          task_id,
          project_id,
          title,
          body,
          kind,
          status,
          position,
          thread_id,
          github_json,
          created_at,
          updated_at
        )
        VALUES (
          ${row.taskId},
          ${row.projectId},
          ${row.title},
          ${row.body},
          ${row.kind},
          ${row.status},
          ${row.position},
          ${row.threadId},
          ${row.github !== null ? JSON.stringify(row.github) : null},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          body = excluded.body,
          kind = excluded.kind,
          status = excluded.status,
          position = excluded.position,
          thread_id = excluded.thread_id,
          github_json = excluded.github_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectTaskRow = SqlSchema.findOneOption({
    Request: GetProjectTaskInput,
    Result: ProjectTaskDbRow,
    execute: ({ taskId, projectId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          project_id AS "projectId",
          title,
          body,
          kind,
          status,
          position,
          thread_id AS "threadId",
          github_json AS "github",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM project_tasks
        WHERE task_id = ${taskId} AND project_id = ${projectId}
      `,
  });

  const listProjectTaskRows = SqlSchema.findAll({
    Request: ListProjectTasksInput,
    Result: ProjectTaskDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          project_id AS "projectId",
          title,
          body,
          kind,
          status,
          position,
          thread_id AS "threadId",
          github_json AS "github",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM project_tasks
        WHERE project_id = ${projectId}
        ORDER BY status ASC, position ASC, created_at ASC, task_id ASC
      `,
  });

  const deleteProjectTaskRow = SqlSchema.void({
    Request: DeleteProjectTaskInput,
    execute: ({ taskId, projectId }) =>
      sql`
        DELETE FROM project_tasks
        WHERE task_id = ${taskId} AND project_id = ${projectId}
      `,
  });

  const deleteProjectTaskRowsByProject = SqlSchema.void({
    Request: DeleteProjectTasksByProjectInput,
    execute: ({ projectId }) =>
      sql`
        DELETE FROM project_tasks
        WHERE project_id = ${projectId}
      `,
  });

  const nextProjectTaskPositionRow = SqlSchema.findAll({
    Request: NextProjectTaskPositionInput,
    Result: NextPositionRow,
    execute: ({ projectId, status }) =>
      sql`
        SELECT COALESCE(MAX(position), -1) + 1 AS "nextPosition"
        FROM project_tasks
        WHERE project_id = ${projectId} AND status = ${status}
      `,
  });

  const upsert: ProjectTaskRepositoryShape["upsert"] = (row) =>
    upsertProjectTaskRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectTaskRepository.upsert:query")),
    );

  const getById: ProjectTaskRepositoryShape["getById"] = (input) =>
    getProjectTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectTaskRepository.getById:query")),
    );

  const listByProject: ProjectTaskRepositoryShape["listByProject"] = (input) =>
    listProjectTaskRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectTaskRepository.listByProject:query")),
    );

  const deleteById: ProjectTaskRepositoryShape["deleteById"] = (input) =>
    deleteProjectTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectTaskRepository.deleteById:query")),
    );

  const deleteByProject: ProjectTaskRepositoryShape["deleteByProject"] = (input) =>
    deleteProjectTaskRowsByProject(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectTaskRepository.deleteByProject:query")),
    );

  const nextPosition: ProjectTaskRepositoryShape["nextPosition"] = (input) =>
    nextProjectTaskPositionRow(input).pipe(
      Effect.map((rows) => rows[0]?.nextPosition ?? 0),
      Effect.mapError(toPersistenceSqlError("ProjectTaskRepository.nextPosition:query")),
    );

  return {
    upsert,
    getById,
    listByProject,
    deleteById,
    deleteByProject,
    nextPosition,
  } satisfies ProjectTaskRepositoryShape;
});

export const ProjectTaskRepositoryLive = Layer.effect(
  ProjectTaskRepository,
  makeProjectTaskRepository,
);
