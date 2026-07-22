import { describe, expect, it } from "@effect/vitest";

import { rollbackTurns } from "./PiAdapter.ts";

describe("PiAdapter thread snapshots", () => {
  it("keeps the remaining turns when rolling back", () => {
    const turns = [
      { id: "one", items: ["assistant"] },
      { id: "two", items: ["tool"] },
      { id: "three", items: ["assistant"] },
    ];
    expect(rollbackTurns(turns, 2)).toEqual([{ id: "one", items: ["assistant"] }]);
    expect(turns).toHaveLength(1);
  });

  it("rejects invalid rollback counts", () => {
    const turns = [{ id: "one", items: [] }];
    expect(rollbackTurns(turns, 0)).toBeUndefined();
    expect(rollbackTurns(turns, 1.5)).toBeUndefined();
    expect(turns).toHaveLength(1);
  });
});
