// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectFailure:off
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

class BoomError extends Error {
  readonly _tag = "BoomError";
}

it("yieldNow + fail inside gen", () =>
  Effect.gen(function* () {
    let attempts = 0;
    while (attempts < 3) {
      attempts += 1;
      yield* Effect.yieldNow;
    }
    return yield* Effect.fail(new BoomError(`boom ${attempts}`));
  }).pipe(
    Effect.flip,
    Effect.map((error: BoomError) => {
      if (error.message !== "boom 3") throw new Error(`unexpected: ${error.message}`);
    }),
  ));
