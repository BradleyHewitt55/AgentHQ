export type FileBrowserEntryKind = "file" | "directory";

export interface FileBrowserDeleteTarget {
  readonly kind: FileBrowserEntryKind;
  readonly path: string;
}

function stripTrailingSlash(treePath: string) {
  return treePath.replace(/\/$/, "");
}

/** Keeps directory deletes from redundantly targeting descendants. */
export function getDeleteTargets(
  selectedTreePaths: readonly string[],
  clickedTreePath: string,
  entryKinds: ReadonlyMap<string, FileBrowserEntryKind>,
) {
  const clickedPath = stripTrailingSlash(clickedTreePath);
  const selectedPaths = selectedTreePaths.map(stripTrailingSlash);
  const candidatePaths = selectedPaths.includes(clickedPath) ? selectedPaths : [clickedPath];
  const targets = [...new Set(candidatePaths)]
    .map((path) => {
      const kind = entryKinds.get(path);
      return kind === undefined ? null : { kind, path };
    })
    .filter((target): target is FileBrowserDeleteTarget => target !== null);

  return targets.filter(
    (target) =>
      !targets.some(
        (parent) =>
          parent.kind === "directory" &&
          parent.path !== target.path &&
          target.path.startsWith(`${parent.path}/`),
      ),
  );
}

/** Removes selected children when their selected folder already carries them. */
export function getClipboardSourcePaths(
  selectedTreePaths: readonly string[],
  clickedTreePath: string,
  entryKinds: ReadonlyMap<string, FileBrowserEntryKind>,
) {
  return getDeleteTargets(selectedTreePaths, clickedTreePath, entryKinds).map(
    (target) => target.path,
  );
}

/** Existing names and self-subtree destinations are always blocked, never overwritten. */
export function getPasteConflicts(
  sourcePaths: readonly string[],
  targetDirectory: string | null,
  entryKinds: ReadonlyMap<string, FileBrowserEntryKind>,
) {
  return sourcePaths.flatMap((sourcePath) => {
    const targetPath = targetDirectory
      ? `${targetDirectory}/${basenamePath(sourcePath)}`
      : basenamePath(sourcePath);
    const targetIsSourceSubtree =
      targetDirectory === sourcePath || targetDirectory?.startsWith(`${sourcePath}/`) === true;
    return targetIsSourceSubtree || entryKinds.has(targetPath) ? [targetPath] : [];
  });
}

function basenamePath(relativePath: string) {
  return relativePath.split("/").at(-1) ?? relativePath;
}

export function getExpandedDirectoryPaths(
  treePaths: readonly string[],
  isExpanded: (treePath: string) => boolean,
) {
  return treePaths.filter((treePath) => treePath.endsWith("/") && isExpanded(treePath));
}

export function isUntouchedInlineCreateName(treePath: string, value: string) {
  return stripTrailingSlash(treePath).split("/").at(-1) === value;
}
