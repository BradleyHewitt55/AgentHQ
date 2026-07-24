import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_RepairProjectionThreadsSettled", (it) => {
  it.effect("adds settled columns when migration 33 was recorded by conflicting work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (33, CURRENT_TIMESTAMP, 'ProjectTasks')
      `;
      yield* runMigrations({ toMigrationInclusive: 34 });

      const columnsBeforeRepair = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isFalse(columnsBeforeRepair.some((column) => column.name === "settled_override"));
      assert.isFalse(columnsBeforeRepair.some((column) => column.name === "settled_at"));

      yield* runMigrations({ toMigrationInclusive: 35 });

      const columnsAfterRepair = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(columnsAfterRepair.some((column) => column.name === "settled_override"));
      assert.isTrue(columnsAfterRepair.some((column) => column.name === "settled_at"));
    }),
  );
});
