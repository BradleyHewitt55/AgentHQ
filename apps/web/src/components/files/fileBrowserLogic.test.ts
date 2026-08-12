import { describe, expect, it } from "@effect/vitest";

import {
  getClipboardSourcePaths,
  getDeleteTargets,
  getExpandedDirectoryPaths,
  getPasteConflicts,
  isUntouchedInlineCreateName,
} from "./fileBrowserLogic";

const entryKinds = new Map([
  ["README.md", "file"],
  ["src", "directory"],
  ["src/app.ts", "file"],
  ["src/lib", "directory"],
  ["src/lib/format.ts", "file"],
  ["notes", "directory"],
] as const);

describe("getDeleteTargets", () => {
  it("uses the full selection when the context-menu row is selected", () => {
    expect(getDeleteTargets(["README.md", "notes/"], "notes/", entryKinds)).toEqual([
      { path: "README.md", kind: "file" },
      { path: "notes", kind: "directory" },
    ]);
  });

  it("keeps a single delete when the context-menu row is outside the selection", () => {
    expect(getDeleteTargets(["README.md", "notes/"], "src/app.ts", entryKinds)).toEqual([
      { path: "src/app.ts", kind: "file" },
    ]);
  });

  it("does not delete selected descendants separately from their folder", () => {
    expect(
      getDeleteTargets(["src/", "src/app.ts", "src/lib/", "src/lib/format.ts"], "src/", entryKinds),
    ).toEqual([{ path: "src", kind: "directory" }]);
  });
});

describe("file browser clipboard", () => {
  it("copies each selected folder once instead of separately copying its descendants", () => {
    expect(
      getClipboardSourcePaths(
        ["src/", "src/app.ts", "src/lib/", "src/lib/format.ts"],
        "src/",
        entryKinds,
      ),
    ).toEqual(["src"]);
  });

  it("blocks existing names and copying a folder into itself", () => {
    expect(getPasteConflicts(["README.md"], null, entryKinds)).toEqual(["README.md"]);
    expect(getPasteConflicts(["src"], "src/lib", entryKinds)).toEqual(["src/lib/src"]);
  });
});

describe("file-browser tree state", () => {
  it("retains only expanded directory paths when resetting entries", () => {
    expect(
      getExpandedDirectoryPaths(
        ["README.md", "src/", "src/app.ts", "notes/"],
        (path) => path === "src/",
      ),
    ).toEqual(["src/"]);
  });

  it("recognizes an untouched default inline-create name", () => {
    expect(isUntouchedInlineCreateName("src/untitled 2", "untitled 2")).toBe(true);
    expect(isUntouchedInlineCreateName("src/untitled", "index.ts")).toBe(false);
  });
});
