import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

it("yieldNow + fail inside gen", () =>
  Effect.gen(function* () {
    let attempts = 0;
    while (attempts < 3) {
      attempts += 1;
      yield* Effect.yieldNow();
    }
    return yield* Effect.fail(new Error(`boom ${attempts}`));
  }).pipe(
    Effect.flip,
    Effect.map((error) => {
      if (error.message !== "boom 3") throw new Error(`unexpected: ${error.message}`);
    }),
  ));
