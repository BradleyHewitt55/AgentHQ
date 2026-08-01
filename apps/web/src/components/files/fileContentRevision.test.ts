import { describe, expect, it } from "vite-plus/test";

import {
  EditableFileCacheKey,
  fileContentRevision,
  projectFileCacheKey,
  projectFileEditorCacheKey,
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

  it("keeps editor identity stable for locally edited contents", () => {
    const cacheKey = projectFileEditorCacheKey("local", "/repo", "file.json", "after", undefined);

    expect(
      projectFileEditorCacheKey("local", "/repo", "file.json", "after edit", {
        cacheKey,
        contents: "after edit",
      }),
    ).toBe(cacheKey);
  });

  it("rotates editor identity for external contents and environments", () => {
    const cacheKey = projectFileEditorCacheKey("local", "/repo", "file.json", "before", undefined);
    const editorFile = { cacheKey, contents: "before" };

    expect(
      projectFileEditorCacheKey("local", "/repo", "file.json", "external edit", editorFile),
    ).not.toBe(cacheKey);
    expect(projectFileEditorCacheKey("remote", "/repo", "file.json", "before", undefined)).not.toBe(
      cacheKey,
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
