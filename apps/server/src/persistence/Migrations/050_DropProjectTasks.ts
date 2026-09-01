import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Tasks moved to GitHub Projects v2 as the source of truth, so the local task
 * rows are dropped. Migrations 035 and 049 created the table and its index;
 * dropping the table removes the index with it. Those entries stay in place so
 * databases that already recorded them keep a truthful ledger.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS project_tasks`;
});
