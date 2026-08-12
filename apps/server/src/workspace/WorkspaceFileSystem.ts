// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectDeleteInput,
  ProjectDeleteResult,
  ProjectMkdirInput,
  ProjectMkdirResult,
  ProjectPasteInput,
  ProjectPasteResult,
  ProjectMoveInput,
  ProjectMoveResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "rename",
      "copy",
      "remove",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export class WorkspaceSourcePathNotFoundError extends Schema.TaggedErrorClass<WorkspaceSourcePathNotFoundError>()(
  "WorkspaceSourcePathNotFoundError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' does not exist: ${this.resolvedPath}`;
  }
}

export class WorkspacePasteTargetNotDirectoryError extends Schema.TaggedErrorClass<WorkspacePasteTargetNotDirectoryError>()(
  "WorkspacePasteTargetNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace paste target '${this.relativePath}' in '${this.workspaceRoot}' is not a directory: ${this.resolvedPath}`;
  }
}

export class WorkspacePasteTargetConflictError extends Schema.TaggedErrorClass<WorkspacePasteTargetConflictError>()(
  "WorkspacePasteTargetConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace paste target '${this.targetPath}' in '${this.workspaceRoot}' already exists; '${this.relativePath}' was not copied.`;
  }
}

export class WorkspaceMoveTargetConflictError extends Schema.TaggedErrorClass<WorkspaceMoveTargetConflictError>()(
  "WorkspaceMoveTargetConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace move target '${this.targetPath}' in '${this.workspaceRoot}' already exists; '${this.relativePath}' was not moved.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceSourcePathNotFoundError,
  WorkspacePasteTargetNotDirectoryError,
  WorkspacePasteTargetConflictError,
  WorkspaceMoveTargetConflictError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Create a directory (and any missing parents) relative to the workspace root. */
    readonly makeDirectory: (
      input: ProjectMkdirInput,
    ) => Effect.Effect<
      ProjectMkdirResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Move or rename a file/directory relative to the workspace root.
     *
     * Rejects missing sources, targets that already exist, and moves that
     * would place a directory inside itself or escape the workspace root.
     */
    readonly moveEntry: (
      input: ProjectMoveInput,
    ) => Effect.Effect<
      ProjectMoveResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Copy or move multiple entries into an existing workspace directory without overwriting. */
    readonly pasteEntries: (
      input: ProjectPasteInput,
    ) => Effect.Effect<
      ProjectPasteResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Recursively delete a file or directory relative to the workspace root. */
    readonly deleteEntry: (
      input: ProjectDeleteInput,
    ) => Effect.Effect<
      ProjectDeleteResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const resolveRealWithinRoot = Effect.fn("WorkspaceFileSystem.resolveRealWithinRoot")(
    function* (input: {
      workspaceRoot: string;
      relativePath: string;
      absolutePath: string;
    }): Effect.fn.Return<
      { realWorkspaceRoot: string; realTargetPath: string },
      WorkspaceFileSystemError
    > {
      const realWorkspaceRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.workspaceRoot),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
            resolvedPath: input.absolutePath,
            operationPath: input.workspaceRoot,
            operation: "realpath-workspace-root",
            cause,
          }),
      });
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(input.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.workspaceRoot,
            relativePath: input.relativePath,
            resolvedPath: input.absolutePath,
            operationPath: input.absolutePath,
            operation: "realpath-target",
            cause,
          }),
      });
      const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
      if (
        relativeRealPath.startsWith(`..${path.sep}`) ||
        relativeRealPath === ".." ||
        path.isAbsolute(relativeRealPath)
      ) {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realWorkspaceRoot,
          resolvedPath: realTargetPath,
        });
      }
      return { realWorkspaceRoot, realTargetPath };
    },
  );

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const { realTargetPath } = yield* resolveRealWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(realTargetPath, "r"),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const existsOnPath = Effect.fn("WorkspaceFileSystem.existsOnPath")(function* (
    absolutePath: string,
  ): Effect.fn.Return<boolean, never> {
    return yield* Effect.tryPromise(() => NodeFSP.stat(absolutePath)).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(false),
        onSuccess: () => Effect.succeed(true),
      }),
    );
  });

  const makeDirectory: WorkspaceFileSystem["Service"]["makeDirectory"] = Effect.fn(
    "WorkspaceFileSystem.makeDirectory",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    // Find the deepest existing ancestor and run the symlink escape check on
    // it; makeDirectory below creates the missing parents. Intermediate
    // components cannot exist until this call, so only real paths can be
    // checked.
    let ancestorPath = target.absolutePath;
    while (!(yield* existsOnPath(ancestorPath))) {
      const parentPath = path.dirname(ancestorPath);
      if (parentPath === ancestorPath) break;
      ancestorPath = parentPath;
    }
    yield* resolveRealWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      absolutePath: ancestorPath,
    });

    yield* fileSystem.makeDirectory(target.absolutePath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  const moveEntry: WorkspaceFileSystem["Service"]["moveEntry"] = Effect.fn(
    "WorkspaceFileSystem.moveEntry",
  )(function* (input) {
    const source = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.fromPath,
    });
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.toPath,
    });

    const sourceStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(source.absolutePath),
      catch: (cause) =>
        new WorkspaceSourcePathNotFoundError({
          workspaceRoot: input.cwd,
          relativePath: input.fromPath,
          resolvedPath: source.absolutePath,
        }),
    });
    yield* resolveRealWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.fromPath,
      absolutePath: source.absolutePath,
    });

    if (yield* existsOnPath(target.absolutePath)) {
      return yield* new WorkspaceMoveTargetConflictError({
        workspaceRoot: input.cwd,
        relativePath: input.fromPath,
        resolvedPath: source.absolutePath,
        targetPath: input.toPath,
      });
    }
    // A directory cannot be moved into its own subtree; rename would leave
    // the filesystem confusingly inconsistent on most platforms.
    if (sourceStat.isDirectory() && input.toPath.startsWith(`${input.fromPath}/`)) {
      return yield* new WorkspaceMoveTargetConflictError({
        workspaceRoot: input.cwd,
        relativePath: input.fromPath,
        resolvedPath: source.absolutePath,
        targetPath: input.toPath,
      });
    }

    const targetParent = path.dirname(target.absolutePath);
    if (yield* existsOnPath(targetParent)) {
      yield* resolveRealWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.toPath,
        absolutePath: targetParent,
      });
    }

    yield* Effect.tryPromise({
      try: () => NodeFSP.rename(source.absolutePath, target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.fromPath,
          resolvedPath: source.absolutePath,
          operationPath: target.absolutePath,
          operation: "rename",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { fromPath: source.relativePath, toPath: target.relativePath };
  });

  const pasteEntries: WorkspaceFileSystem["Service"]["pasteEntries"] = Effect.fn(
    "WorkspaceFileSystem.pasteEntries",
  )(function* (input) {
    const target =
      input.targetDirectory === undefined
        ? { absolutePath: input.cwd, relativePath: "" }
        : yield* workspacePaths.resolveRelativePathWithinRoot({
            workspaceRoot: input.cwd,
            relativePath: input.targetDirectory,
          });
    const targetStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(target.absolutePath),
      catch: () =>
        new WorkspaceSourcePathNotFoundError({
          workspaceRoot: input.cwd,
          relativePath: input.targetDirectory ?? ".",
          resolvedPath: target.absolutePath,
        }),
    });
    if (!targetStat.isDirectory()) {
      return yield* new WorkspacePasteTargetNotDirectoryError({
        workspaceRoot: input.cwd,
        relativePath: input.targetDirectory ?? ".",
        resolvedPath: target.absolutePath,
      });
    }
    yield* resolveRealWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.targetDirectory ?? ".",
      absolutePath: target.absolutePath,
    });

    const sources = yield* Effect.forEach(input.sourcePaths, (relativePath) =>
      Effect.gen(function* () {
        const source = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: input.cwd,
          relativePath,
        });
        const stat = yield* Effect.tryPromise({
          try: () => NodeFSP.stat(source.absolutePath),
          catch: () =>
            new WorkspaceSourcePathNotFoundError({
              workspaceRoot: input.cwd,
              relativePath,
              resolvedPath: source.absolutePath,
            }),
        });
        yield* resolveRealWithinRoot({
          workspaceRoot: input.cwd,
          relativePath,
          absolutePath: source.absolutePath,
        });
        const destinationPath = path.join(target.absolutePath, path.basename(source.absolutePath));
        const destinationRelativePath = target.relativePath
          ? `${target.relativePath}/${path.basename(source.relativePath)}`
          : path.basename(source.relativePath);
        return { source, stat, destinationPath, destinationRelativePath };
      }),
    );

    const plannedDestinations = new Set<string>();
    for (const entry of sources) {
      if (
        plannedDestinations.has(entry.destinationRelativePath) ||
        (entry.stat.isDirectory() &&
          (target.relativePath === entry.source.relativePath ||
            target.relativePath.startsWith(`${entry.source.relativePath}/`))) ||
        (yield* existsOnPath(entry.destinationPath))
      ) {
        return yield* new WorkspacePasteTargetConflictError({
          workspaceRoot: input.cwd,
          relativePath: entry.source.relativePath,
          resolvedPath: entry.source.absolutePath,
          targetPath: entry.destinationRelativePath,
        });
      }
      plannedDestinations.add(entry.destinationRelativePath);
    }

    for (const entry of sources) {
      yield* Effect.tryPromise({
        try: () =>
          input.operation === "cut"
            ? NodeFSP.rename(entry.source.absolutePath, entry.destinationPath)
            : NodeFSP.cp(entry.source.absolutePath, entry.destinationPath, {
                recursive: entry.stat.isDirectory(),
                force: false,
                errorOnExist: true,
              }),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: entry.source.relativePath,
            resolvedPath: entry.source.absolutePath,
            operationPath: entry.destinationPath,
            operation: input.operation === "cut" ? "rename" : "copy",
            cause,
          }),
      });
    }
    yield* workspaceEntries.refresh(input.cwd);
    return { copiedPaths: sources.map((entry) => entry.destinationRelativePath) };
  });

  const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const targetStat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(target.absolutePath),
      catch: (cause) =>
        new WorkspaceSourcePathNotFoundError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
        }),
    });
    // Escape check, then delete the lexical path: Node's rm/unlink do not
    // follow the final component, so a symlink entry is removed as itself
    // while the realpath check above still rejects workspaces that resolve
    // outside the root.
    yield* resolveRealWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });
    yield* Effect.tryPromise({
      try: () =>
        targetStat.isDirectory()
          ? NodeFSP.rm(target.absolutePath, { recursive: true, force: false })
          : NodeFSP.unlink(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "remove",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({
    deleteEntry,
    pasteEntries,
    readFile,
    writeFile,
    makeDirectory,
    moveEntry,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
