import { describe, expect, it } from "vite-plus/test";

import {
  EditableFileCacheKey,
  fileContentRevision,
  projectFileCacheKey,
} from "./fileContentRevision";

describe("fileContentRevision", () => {
  it("changes for same-length edits", () => {
    expect(fileContentRevision("nodeVersion")).not.toBe(fileContentRevision("nodeVeasdrs"));
  });

  it("keeps identical contents stable", () => {
    expect(projectFileCacheKey("/repo", "file.json", "contents")).toBe(
      projectFileCacheKey("/repo", "file.json", "contents"),
    );
  });
});

describe("EditableFileCacheKey", () => {
  it("keeps the rendered editor stable for optimistic local updates", () => {
    const revision = new EditableFileCacheKey("/repo", "file.json", "before");
    const initial = revision.resolve("before");

    revision.localChange("after");

    expect(revision.resolve("after")).toEqual(initial);
  });

  it("changes when contents are updated outside the editor", () => {
    const revision = new EditableFileCacheKey("/repo", "file.json", "before");
    const initial = revision.resolve("before");

    const external = revision.resolve("external update");
    expect(external.cacheKey).not.toBe(initial.cacheKey);
    expect(external.contents).toBe("external update");
  });
});
