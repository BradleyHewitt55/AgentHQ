import { ProviderSubscriptionUsage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type PersistenceDecodeError,
  type PersistenceSqlError,
  toPersistenceSqlError,
} from "./Errors.ts";

const SubscriptionUsageRow = Schema.Struct({
  snapshot: ProviderSubscriptionUsage,
});

const SubscriptionUsageDbRow = Schema.Struct({
  snapshot: Schema.fromJsonString(ProviderSubscriptionUsage),
});

export type SubscriptionUsageRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export class SubscriptionUsageRepository extends Context.Service<
  SubscriptionUsageRepository,
  {
    /** Replaces the last runtime-reported snapshot for one provider. */
    readonly upsert: (
      snapshot: ProviderSubscriptionUsage,
    ) => Effect.Effect<void, SubscriptionUsageRepositoryError>;

    /** Returns only providers that have emitted subscription telemetry. */
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProviderSubscriptionUsage>,
      SubscriptionUsageRepositoryError
    >;
  }
>()("t3/persistence/SubscriptionUsage/SubscriptionUsageRepository") {}

const makeSubscriptionUsageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertSnapshot = SqlSchema.void({
    Request: SubscriptionUsageRow,
    execute: ({ snapshot }) =>
      sql`
        INSERT INTO provider_subscription_usage (provider, snapshot_json)
        VALUES (${snapshot.provider}, ${JSON.stringify(snapshot)})
        ON CONFLICT (provider)
        DO UPDATE SET snapshot_json = excluded.snapshot_json
      `,
  });

  const listSnapshots = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SubscriptionUsageDbRow,
    execute: () =>
      sql`
        SELECT snapshot_json AS "snapshot"
        FROM provider_subscription_usage
        ORDER BY provider ASC
      `,
  });

  return {
    upsert: (snapshot) =>
      upsertSnapshot({ snapshot }).pipe(
        Effect.mapError(toPersistenceSqlError("SubscriptionUsageRepository.upsert:query")),
      ),
    list: () =>
      listSnapshots(undefined).pipe(
        Effect.mapError(toPersistenceSqlError("SubscriptionUsageRepository.list:query")),
        Effect.map((rows) => rows.map((row) => row.snapshot)),
      ),
  } satisfies SubscriptionUsageRepository["Service"];
});

export const layer = Layer.effect(SubscriptionUsageRepository, makeSubscriptionUsageRepository);
