import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      position INTEGER NOT NULL,
      thread_id TEXT,
      github_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Board reads are always project-scoped and ordered by column then position.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_tasks_board
    ON project_tasks (project_id, status, position, created_at)
  `;
});
