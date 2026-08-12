import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_subscription_usage (
      provider TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL
    )
  `;
});
