import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
  FileTreeDropResult,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry, ScopedThreadRef } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { ClipboardPaste, Copy, FilePlus2, FolderPlus, RotateCw, Scissors } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { Label } from "~/components/ui/label";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { resolvePathLinkTarget } from "~/terminal-links";

import {
  getClipboardSourcePaths,
  getDeleteTargets,
  getExpandedDirectoryPaths,
  getPasteConflicts,
  isUntouchedInlineCreateName,
  type FileBrowserDeleteTarget,
} from "./fileBrowserLogic";
import { getFileBrowserClipboard, setFileBrowserClipboard } from "./fileBrowserClipboard";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  threadRef: ScopedThreadRef;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  /** Close the preview pane for a file (used when the file is deleted). */
  onCloseFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

/** Strip the trailing slash directory rows carry in this tree. */
function stripTrailingSlash(treePath: string): string {
  return treePath.replace(/\/$/, "");
}

function basenamePath(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

function commandFailureMessage(cause: unknown): string {
  const squashed = Cause.squash(cause as Cause.Cause<unknown>);
  return squashed instanceof Error ? squashed.message : String(squashed);
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileClipboardButtons(props: {
  canCopy: boolean;
  canPaste: boolean;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Copy selected files"
              disabled={!props.canCopy}
              onClick={props.onCopy}
            />
          }
        >
          <Copy />
        </TooltipTrigger>
        <TooltipPopup>Copy selected files</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Cut selected files"
              disabled={!props.canCopy}
              onClick={props.onCut}
            />
          }
        >
          <Scissors />
        </TooltipTrigger>
        <TooltipPopup>Cut selected files</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Paste files"
              disabled={!props.canPaste}
              onClick={props.onPaste}
            />
          }
        >
          <ClipboardPaste />
        </TooltipTrigger>
        <TooltipPopup>Paste into selected folder or project root</TooltipPopup>
      </Tooltip>
    </>
  );
}

function NewFileButton(props: { onNewFile: () => void; onNewFolder: () => void }) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="New file"
              onClick={props.onNewFile}
            />
          }
        >
          <FilePlus2 />
        </TooltipTrigger>
        <TooltipPopup>New file</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="New folder"
              onClick={props.onNewFolder}
            />
          }
        >
          <FolderPlus />
        </TooltipTrigger>
        <TooltipPopup>New folder</TooltipPopup>
      </Tooltip>
    </>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

interface EntryNameDialogProps {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  initialName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

function EntryNameDialog({
  open,
  title,
  description,
  submitLabel,
  initialName,
  onSubmit,
  onClose,
}: EntryNameDialogProps) {
  const [name, setName] = useState(initialName);
  const formId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (trimmed.length === 0) return;
              onSubmit(trimmed);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-name`}>Name</Label>
              <Input
                id={`${formId}-name`}
                autoFocus
                spellCheck={false}
                value={name}
                placeholder="Name"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  onClose();
                }}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button form={formId} type="submit">
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function NewButtonRow(props: { onNewFile: () => void; onNewFolder: () => void }) {
  return (
    <div className="flex shrink-0 gap-1 pt-1">
      <Button type="button" variant="ghost" size="xs" className="flex-1" onClick={props.onNewFile}>
        <FilePlus2 className="size-3.5" />
        New file
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="flex-1"
        onClick={props.onNewFolder}
      >
        <FolderPlus className="size-3.5" />
        New folder
      </Button>
    </div>
  );
}

interface CreateTarget {
  kind: "file" | "folder";
  parentPath: string | null;
}
interface InlineCreateDraft extends CreateTarget {
  placeholderPath: string;
}
interface RenameTarget {
  path: string;
  kind: "file" | "directory";
}
type DeleteTarget = FileBrowserDeleteTarget;
interface PasteConflict {
  operation: "copy" | "cut";
  paths: readonly string[];
}

const FILE_TREE_EXPANSION_STORAGE_PREFIX = "t3code:file-tree-expansion:v1";

function fileTreeExpansionStorageKey(environmentId: EnvironmentId, cwd: string): string {
  return `${FILE_TREE_EXPANSION_STORAGE_PREFIX}:${environmentId}:${cwd}`;
}

function readPersistedExpandedPaths(environmentId: EnvironmentId, cwd: string): readonly string[] {
  try {
    const value = window.localStorage.getItem(fileTreeExpansionStorageKey(environmentId, cwd));
    if (value === null) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === "string").slice(0, 500)
      : [];
  } catch {
    return [];
  }
}

function persistExpandedPaths(
  environmentId: EnvironmentId,
  cwd: string,
  paths: readonly string[],
): void {
  try {
    window.localStorage.setItem(
      fileTreeExpansionStorageKey(environmentId, cwd),
      JSON.stringify(paths.slice(0, 500)),
    );
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  threadRef,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onCloseFile,
  onRefreshSelectedFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  // Ignored entries stay in the listing so their rows render dimmed; the
  // tree's git-status lane paints them and any rows beneath an ignored
  // directory with the dimmed color.
  const gitStatus = useMemo(
    () =>
      entries
        .filter((entry) => entry.ignored === true)
        .map((entry) => ({ path: treePath(entry), status: "ignored" as const })),
    [entries],
  );
  const previousTreePathsRef = useRef<readonly string[]>([]);
  const persistedExpandedPathsRef = useRef(readPersistedExpandedPaths(environmentId, cwd));
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);
  const selectedPathRef = useRef<string | null>(selectedPath);
  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const mkdir = useAtomCommand(projectEnvironment.mkdir);
  const moveEntry = useAtomCommand(projectEnvironment.moveEntry);
  const deleteEntry = useAtomCommand(projectEnvironment.deleteEntry);
  const pasteEntries = useAtomCommand(projectEnvironment.pasteEntries);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });

  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  // Inline "new file"/"new folder" drafts render as a temporary row in the
  // tree (via the tree's own rename machinery) instead of a dialog. The draft
  // records the kind and parent, and is cleared on commit or when any other
  // rename begins (a cancelled draft just removes the temporary row).
  const inlineCreateDraftRef = useRef<InlineCreateDraft | null>(null);
  // Capture phase sees focusout before Pierre's synchronous onBlur commit.
  // Keep that intent until onRename has had a chance to consume it.
  const discardInlineCreateDraftRef = useRef<InlineCreateDraft | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<ReadonlyArray<DeleteTarget> | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [selectedTreePaths, setSelectedTreePaths] = useState<readonly string[]>([]);
  const [pasteConflict, setPasteConflict] = useState<PasteConflict | null>(null);
  const [fileClipboardRevision, setFileClipboardRevision] = useState(0);

  // Keep the tree in step with the real workspace: entry mutations refresh
  // the query on success, and the panel re-fetches whenever the window
  // regains focus (file changes from agents, git operations, or other
  // surfaces all happen while the panel is in the background).
  const refreshEntries = entriesQuery.refresh;
  useEffect(() => {
    const listener = () => {
      if (document.visibilityState === "visible") refreshEntries();
    };
    window.addEventListener("focus", listener);
    document.addEventListener("visibilitychange", listener);
    return () => {
      window.removeEventListener("focus", listener);
      document.removeEventListener("visibilitychange", listener);
    };
  }, [refreshEntries]);

  const deleteContentsCount = useMemo(
    () =>
      deleteTargets?.reduce(
        (count, target) =>
          target.kind === "directory"
            ? count + entries.filter((entry) => entry.path.startsWith(`${target.path}/`)).length
            : count,
        0,
      ) ?? 0,
    [deleteTargets, entries],
  );

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const commitCreate = useCallback(
    (kind: "file" | "folder", parentPath: string | null, name: string) => {
      const relativePath = parentPath ? `${parentPath}/${name}` : name;
      const run =
        kind === "folder"
          ? mkdir({ environmentId, input: { cwd, relativePath } })
          : writeFile({ environmentId, input: { cwd, relativePath, contents: "" } });
      void run.then((result) => {
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: kind === "folder" ? "Failed to create folder" : "Failed to create file",
            description: commandFailureMessage(result.cause),
          });
          return;
        }
        if (kind === "file") onOpenFile(relativePath);
      });
    },
    [cwd, environmentId, mkdir, onOpenFile, writeFile],
  );

  const commitRename = useCallback(
    (target: RenameTarget, name: string) => {
      const parentDir = target.path.includes("/")
        ? target.path.slice(0, target.path.lastIndexOf("/"))
        : "";
      const toPath = parentDir ? `${parentDir}/${name}` : name;
      if (toPath === target.path) return;
      void moveEntry({ environmentId, input: { cwd, fromPath: target.path, toPath } }).then(
        (result) => {
          if (result._tag === "Failure") {
            toastManager.add({
              type: "error",
              title: "Rename failed",
              description: commandFailureMessage(result.cause),
            });
            return;
          }
          if (selectedPathRef.current === target.path && target.kind === "file") {
            onOpenFile(toPath);
          }
        },
      );
    },
    [cwd, environmentId, moveEntry, onOpenFile],
  );

  const commitMove = useCallback(
    (fromPath: string, toPath: string) => {
      if (toPath === fromPath) return;
      void moveEntry({ environmentId, input: { cwd, fromPath, toPath } }).then((result) => {
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Move failed",
            description: commandFailureMessage(result.cause),
          });
          return;
        }
        if (selectedPathRef.current === fromPath) {
          onOpenFile(toPath);
        }
      });
    },
    [cwd, environmentId, moveEntry, onOpenFile],
  );

  const copySelection = useCallback(
    (operation: "copy" | "cut", clickedTreePath: string, selectedTreePaths: readonly string[]) => {
      const sourcePaths = getClipboardSourcePaths(
        selectedTreePaths,
        clickedTreePath,
        entryKindsRef.current,
      );
      if (sourcePaths.length === 0) return;
      setFileBrowserClipboard({ cwd, environmentId, operation, sourcePaths });
      setFileClipboardRevision((revision) => revision + 1);
      toastManager.add({
        type: "success",
        title: operation === "copy" ? "Files copied" : "Files cut",
        description: `${sourcePaths.length} item${sourcePaths.length === 1 ? "" : "s"} ready to paste.`,
      });
    },
    [cwd, environmentId],
  );

  const pasteIntoDirectory = useCallback(
    (targetDirectory: string | null) => {
      const clipboard = getFileBrowserClipboard();
      if (clipboard === null) return;
      if (clipboard.environmentId !== environmentId || clipboard.cwd !== cwd) {
        toastManager.add({
          type: "error",
          title: "Paste unavailable",
          description: "Files can only be pasted within the project where they were copied.",
        });
        return;
      }
      const conflicts = getPasteConflicts(
        clipboard.sourcePaths,
        targetDirectory,
        entryKindsRef.current,
      );
      if (conflicts.length > 0) {
        setPasteConflict({ operation: clipboard.operation, paths: conflicts });
        return;
      }
      void pasteEntries({
        environmentId,
        input: {
          cwd,
          sourcePaths: clipboard.sourcePaths,
          targetDirectory: targetDirectory ?? undefined,
          operation: clipboard.operation,
        },
      }).then((result) => {
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Paste failed",
            description: commandFailureMessage(result.cause),
          });
          return;
        }
        if (clipboard.operation === "cut") {
          setFileBrowserClipboard(null);
          setFileClipboardRevision((revision) => revision + 1);
          const previewed = selectedPathRef.current;
          const movedSource = previewed
            ? clipboard.sourcePaths.find(
                (sourcePath) => previewed === sourcePath || previewed.startsWith(`${sourcePath}/`),
              )
            : undefined;
          if (previewed && movedSource) {
            const destination = targetDirectory
              ? `${targetDirectory}/${basenamePath(movedSource)}`
              : basenamePath(movedSource);
            onOpenFile(`${destination}${previewed.slice(movedSource.length)}`);
          }
        }
        refreshEntries();
        toastManager.add({
          type: "success",
          title: clipboard.operation === "copy" ? "Files pasted" : "Files moved",
          description: `${clipboard.sourcePaths.length} item${clipboard.sourcePaths.length === 1 ? "" : "s"} ${clipboard.operation === "copy" ? "copied" : "moved"}.`,
        });
      });
    },
    [cwd, environmentId, onOpenFile, pasteEntries, refreshEntries],
  );

  const commitDelete = useCallback(
    (targets: ReadonlyArray<DeleteTarget>) => {
      const previewed = selectedPathRef.current;
      void Promise.all(
        targets.map(async (target) => {
          const result = await deleteEntry({
            environmentId,
            input: { cwd, relativePath: target.path },
          });
          if (result._tag === "Failure") {
            toastManager.add({
              type: "error",
              title: "Delete failed",
              description: commandFailureMessage(result.cause),
            });
          }
          return { result, target };
        }),
      ).then((results) => {
        if (
          previewed !== null &&
          results.some(
            ({ result, target }) =>
              result._tag === "Success" &&
              (previewed === target.path || previewed.startsWith(`${target.path}/`)),
          )
        ) {
          onCloseFile(previewed);
        }
      });
    },
    [cwd, deleteEntry, environmentId, onCloseFile],
  );

  const handleOpenInBrowser = useCallback(
    (relativePath: string) => {
      if (!environmentHttpBaseUrl) return;
      void (async () => {
        const result = await openFileInPreview({
          threadRef,
          filePath: resolvePathLinkTarget(relativePath, cwd),
          httpBaseUrl: environmentHttpBaseUrl,
          createAssetUrl,
          openPreview,
        });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      })();
    },
    [createAssetUrl, cwd, environmentHttpBaseUrl, openPreview, threadRef],
  );

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = stripTrailingSlash(item.path);
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    const items: Array<{ id: string; label: string }> = [];
    if (item.kind === "directory") {
      items.push(
        { id: "new-file", label: "New file" },
        { id: "new-folder", label: "New folder" },
        { id: "paste", label: "Paste" },
      );
    }
    items.push({ id: "cut", label: "Cut" }, { id: "copy-mention", label: "Copy mention" });
    items.push({ id: "add-to-chat", label: "Add to chat" });
    if (item.kind === "file") {
      items.push({ id: "open", label: "Open" });
      if (isPreviewSupportedInRuntime() && isBrowserPreviewFile(relativePath)) {
        items.push({ id: "open-in-browser", label: "Open in browser" });
      }
    }
    items.push({ id: "rename", label: "Rename" }, { id: "delete", label: "Delete" });
    try {
      const clicked = await api.contextMenu.show(items, position);
      switch (clicked) {
        case "cut":
          copySelection("cut", item.path, model.getSelectedPaths());
          return;
        case "paste":
          pasteIntoDirectory(relativePath);
          return;
        case "copy-mention":
          try {
            await writeTextToClipboard(mention);
            toastManager.add({
              type: "success",
              title: "Mention copied",
              description: relativePath,
            });
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Failed to copy mention",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
          return;
        case "add-to-chat": {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "Open a chat for this project and try again.",
            });
            return;
          }
          const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
          if (!inserted) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "The chat isn't ready to accept input right now.",
            });
          }
          return;
        }
        case "open":
          onOpenFile(relativePath);
          return;
        case "open-in-browser":
          handleOpenInBrowser(relativePath);
          return;
        case "rename":
          setRenameTarget({ path: relativePath, kind: item.kind });
          return;
        case "delete": {
          const targets = getDeleteTargets(
            model.getSelectedPaths(),
            item.path,
            entryKindsRef.current,
          );
          if (targets.length > 0) setDeleteTargets(targets);
          return;
        }
        case "new-file":
          startInlineCreate("file", relativePath);
          return;
        case "new-folder":
          startInlineCreate("folder", relativePath);
          return;
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Entries can move onto any folder row (or the root) via drag and drop;
    // rejects drops that would stack an entry onto itself or collide with an
    // existing entry name.
    dragAndDrop: {
      canDrop: (event) =>
        event.draggedPaths.every((draggedPath) => {
          const sourcePath = stripTrailingSlash(draggedPath);
          const targetDir =
            event.target.directoryPath === null
              ? null
              : stripTrailingSlash(event.target.directoryPath);
          // Dragging onto the tree root moves the entry into the project
          // root; reject it only when the name already exists there.
          if (targetDir === null) {
            return !entryKindsRef.current.has(basenamePath(sourcePath));
          }
          if (targetDir === sourcePath) {
            return false;
          }
          if (targetDir.startsWith(`${sourcePath}/`)) {
            return false;
          }
          const toPath = `${targetDir}/${basenamePath(sourcePath)}`;
          return !entryKindsRef.current.has(toPath);
        }),
      onDropComplete: (event: FileTreeDropResult) => {
        const targetDir =
          event.target.directoryPath === null
            ? null
            : stripTrailingSlash(event.target.directoryPath);
        for (const draggedPath of event.draggedPaths) {
          const sourcePath = stripTrailingSlash(draggedPath);
          const toPath =
            targetDir === null
              ? basenamePath(sourcePath)
              : `${targetDir}/${basenamePath(sourcePath)}`;
          commitMove(sourcePath, toPath);
        }
      },
      onDropError: (message) =>
        toastManager.add({ type: "error", title: "Move failed", description: message }),
    },
    // Any new rename gesture supersedes an abandoned inline create draft.
    renaming: {
      canRename: () => {
        inlineCreateDraftRef.current = null;
        discardInlineCreateDraftRef.current = null;
        return true;
      },
      onRename: ({ sourcePath, destinationPath }) => {
        const draft = inlineCreateDraftRef.current;
        if (draft !== null) {
          const discardDraft = discardInlineCreateDraftRef.current === draft;
          inlineCreateDraftRef.current = null;
          discardInlineCreateDraftRef.current = null;
          // The temporary row retires immediately; the created entry arrives
          // with the refreshed entries query (see `refreshListEntriesAfterMutation`).
          model.remove(draft.placeholderPath);
          if (discardDraft) return;
          const name = basenamePath(stripTrailingSlash(destinationPath)).trim();
          if (name.length > 0) {
            commitCreate(draft.kind, draft.parentPath, name);
          }
          return;
        }
        commitMove(stripTrailingSlash(sourcePath), stripTrailingSlash(destinationPath));
      },
      onError: (message) =>
        toastManager.add({ type: "error", title: "Rename failed", description: message }),
    },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 0,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      setSelectedTreePaths(selectedPaths);
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      const lastSelectedPath = selectedPaths.at(-1);
      if (lastSelectedPath !== undefined) {
        const lastPath = stripTrailingSlash(lastSelectedPath);
        if (entryKindsRef.current.get(lastPath) === "directory") {
          setSelectedFolderPath(lastPath);
        }
      }
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = lastSelectedPath?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);

  useEffect(
    () => () => {
      const expandedPaths = getExpandedDirectoryPaths(previousTreePathsRef.current, (path) => {
        const item = model.getItem(path);
        return item?.isDirectory() === true && "isExpanded" in item && item.isExpanded();
      });
      persistExpandedPaths(environmentId, cwd, expandedPaths);
    },
    [cwd, environmentId, model],
  );

  // Begin an inline create draft: add a temporary "untitled" row at the
  // target folder (or the tree root) and hand it to the tree's rename input.
  // The tree removes the row if the user cancels; on commit, the draft is
  // committed as a create (see the `renaming.onRename` handler).
  const startInlineCreate = useCallback(
    (kind: "file" | "folder", parentPath: string | null) => {
      let tempName = "untitled";
      let counter = 2;
      const basePath = parentPath === null ? "" : `${stripTrailingSlash(parentPath)}/`;
      while (entryKindsRef.current.has(`${basePath}${tempName}`)) {
        tempName = `untitled ${counter}`;
        counter += 1;
      }
      const tempRowPath = `${basePath}${tempName}${kind === "folder" ? "/" : ""}`;
      // The store resolves newly added rows asynchronously, so start the
      // rename once the add mutation has landed; until then a cancel leaves
      // the row around, so remove it ourselves if no rename starts.
      let removeIfCanceled = true;
      const unsubscribe = model.onMutation("add", (event) => {
        if (event.path !== tempRowPath) return;
        unsubscribe();
        removeIfCanceled = false;
        if (!model.startRenaming(tempRowPath, { removeIfCanceled: true })) {
          model.remove(tempRowPath);
          return;
        }
        inlineCreateDraftRef.current = { kind, parentPath, placeholderPath: tempRowPath };
      });
      model.add(tempRowPath);
      if (removeIfCanceled) {
        model.remove(tempRowPath);
        unsubscribe();
      }
    },
    [model],
  );

  // The tree's own DnD and context-menu plumbing only knows rows; blank
  // area within the tree (between/around rows) is dead space it never
  // resolves to the project root. The tree renders in shadow DOM, so wire
  // handlers on the wrapper that synthesize a root drop target and a root
  // context menu when no row is under the pointer. Row gestures pass through
  // untouched (the composed path contains a row element).
  const treeSurfaceRef = useRef<HTMLDivElement | null>(null);
  const showRootContextMenu = useCallback(async () => {
    const api = readLocalApi();
    if (!api) return;
    const pointer = contextMenuPointerRef.current;
    const position =
      pointer !== null && performance.now() - pointer.at < 1000
        ? { x: pointer.x, y: pointer.y }
        : null;
    const items: Array<{ id: string; label: string }> = [
      { id: "new-file", label: "New file" },
      { id: "new-folder", label: "New folder" },
      { id: "paste", label: "Paste" },
    ];
    const clicked = await api.contextMenu.show(items, position ?? undefined);
    if (clicked === "new-file") startInlineCreate("file", null);
    if (clicked === "new-folder") startInlineCreate("folder", null);
    if (clicked === "paste") pasteIntoDirectory(null);
  }, [pasteIntoDirectory, startInlineCreate]);
  useEffect(() => {
    const surface = treeSurfaceRef.current;
    if (surface === null) return;
    const isTreeRowTarget = (event: Event) =>
      event
        .composedPath()
        .some((node) => node instanceof Element && node.closest(`[data-type='item']`) !== null);
    const handleContextMenu = (event: MouseEvent) => {
      if (isTreeRowTarget(event)) return;
      event.preventDefault();
      void showRootContextMenu();
    };
    const handleDrop = (event: DragEvent) => {
      if (isTreeRowTarget(event)) return;
      if (!dragMention.isDragInProgress()) return;
      event.preventDefault();
      event.stopPropagation();
      // Blank-area drops move every dragged path into the project root.
      // Mirror the `dragAndDrop.canDrop` guards: skip entries already at the
      // root and entries whose root name is already taken.
      const moves: Array<[string, string]> = [];
      for (const draggedPath of dragMention.getDraggedPaths()) {
        const sourcePath = stripTrailingSlash(draggedPath);
        const toPath = basenamePath(sourcePath);
        if (toPath === sourcePath || entryKindsRef.current.has(toPath)) continue;
        moves.push([sourcePath, toPath]);
      }
      for (const [sourcePath, toPath] of moves) commitMove(sourcePath, toPath);
    };
    surface.addEventListener("contextmenu", handleContextMenu);
    surface.addEventListener("drop", handleDrop, true);
    return () => {
      surface.removeEventListener("contextmenu", handleContextMenu);
      surface.removeEventListener("drop", handleDrop, true);
    };
  }, [commitMove, dragMention, showRootContextMenu]);

  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const handleRefresh = () => {
    entriesQuery.refresh();
    onRefreshSelectedFile?.();
  };

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    const expandedPaths =
      previousTreePathsRef.current.length === 0
        ? persistedExpandedPathsRef.current
        : getExpandedDirectoryPaths(previousTreePathsRef.current, (path) => {
            const item = model.getItem(path);
            return item?.isDirectory() === true && "isExpanded" in item && item.isExpanded();
          });
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths, { initialExpandedPaths: expandedPaths });
    model.setGitStatus(gitStatus);
  }, [entryKinds, gitStatus, model, treePaths]);

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Entry refreshes rebuild treePaths while the same preview stays open.
    // Replaying a handled reveal would close an active tree search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    if (entryKinds.get(selectedPath) !== "file") return;
    const selectedItem = model.getItem(selectedPath);
    if (!selectedItem) return;

    // A selection that originated inside the tree (clicking a row, possibly
    // in an active tree search) is already visible; re-revealing it would
    // close the search and clobber the user's context. Only sync external
    // opens (file picker, content search, chat links).
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory rows are registered with a trailing slash (see treePath), so
    // ancestor lookups must use the same form to expand them.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    selectedItem.select();
    model.scrollToPath(selectedPath, { focus: true, offset: "center" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId, treePaths]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleFileClipboardShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (
        event
          .composedPath()
          .some(
            (node) =>
              node instanceof HTMLElement &&
              (node.isContentEditable ||
                node instanceof HTMLInputElement ||
                node instanceof HTMLTextAreaElement),
          )
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      const selection = model.getSelectedPaths();
      if (key === "c" || key === "x") {
        const clickedPath = selection.at(-1);
        if (clickedPath === undefined) return;
        event.preventDefault();
        copySelection(key === "c" ? "copy" : "cut", clickedPath, selection);
        return;
      }
      if (key !== "v") return;
      event.preventDefault();
      const selectedDirectoryPath = selection.map(stripTrailingSlash).at(-1);
      pasteIntoDirectory(
        selectedDirectoryPath && entryKindsRef.current.get(selectedDirectoryPath) === "directory"
          ? selectedDirectoryPath
          : null,
      );
    };
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("keydown", handleFileClipboardShortcut);
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("keydown", handleFileClipboardShortcut);
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [copySelection, dragMention, model, pasteIntoDirectory]);

  useEffect(() => {
    const surface = treeSurfaceRef.current;
    if (surface === null) return;
    const handleRenameFocusOut = (event: FocusEvent) => {
      const renameInput = event
        .composedPath()
        .find(
          (node): node is HTMLInputElement =>
            node instanceof HTMLInputElement && node.dataset.itemRenameInput === "true",
        );
      const draft = inlineCreateDraftRef.current;
      if (
        renameInput === undefined ||
        draft === null ||
        !isUntouchedInlineCreateName(draft.placeholderPath, renameInput.value)
      ) {
        return;
      }
      // Pierre commits inline renames synchronously from onBlur. Capture the
      // discard intent now so `onRename` can suppress that create. The
      // microtask is a fallback for Pierre versions that treat this as a
      // no-op rename and never call `onRename`.
      discardInlineCreateDraftRef.current = draft;
      queueMicrotask(() => {
        if (discardInlineCreateDraftRef.current !== draft) return;
        discardInlineCreateDraftRef.current = null;
        if (inlineCreateDraftRef.current !== draft) return;
        inlineCreateDraftRef.current = null;
        model.remove(draft.placeholderPath);
      });
    };
    surface.addEventListener("focusout", handleRenameFocusOut, true);
    return () => surface.removeEventListener("focusout", handleRenameFocusOut, true);
  }, [model]);

  const newFileParent = selectedFolderPath;
  const selectedPasteTarget = selectedTreePaths.at(-1);
  const pasteTargetDirectory =
    selectedPasteTarget !== undefined &&
    entryKinds.get(stripTrailingSlash(selectedPasteTarget)) === "directory"
      ? stripTrailingSlash(selectedPasteTarget)
      : null;
  const deleteTarget = deleteTargets?.length === 1 ? (deleteTargets[0] ?? null) : null;

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={entriesQuery.isPending} onRefresh={handleRefresh} />
        <FileClipboardButtons
          canCopy={selectedTreePaths.length > 0}
          canPaste={getFileBrowserClipboard() !== null || fileClipboardRevision > 0}
          onCopy={() => {
            const clickedPath = selectedTreePaths.at(-1);
            if (clickedPath !== undefined) copySelection("copy", clickedPath, selectedTreePaths);
          }}
          onCut={() => {
            const clickedPath = selectedTreePaths.at(-1);
            if (clickedPath !== undefined) copySelection("cut", clickedPath, selectedTreePaths);
          }}
          onPaste={() => pasteIntoDirectory(pasteTargetDirectory)}
        />
        <NewFileButton
          onNewFile={() => startInlineCreate("file", newFileParent)}
          onNewFolder={() => startInlineCreate("folder", newFileParent)}
        />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={search.close}
        />
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <>
          {entriesQuery.data?.truncated ? (
            <div className="px-3 pt-2 text-[11px] leading-relaxed text-muted-foreground">
              The workspace has more paths than the file tree index supports; showing the first{" "}
              {entries.length.toLocaleString()}.
            </div>
          ) : null}
          <div ref={treeSurfaceRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <FileTree
              model={model}
              aria-label={`${projectName} files`}
              className="min-h-0 flex-1 overflow-hidden"
              style={{
                colorScheme: resolvedTheme,
                ["--trees-fg-override" as string]: "var(--foreground)",
              }}
            />
          </div>
        </>
      )}
      {renameTarget !== null && (
        <EntryNameDialog
          key={`rename:${renameTarget.path}`}
          open={true}
          title={`Rename ${renameTarget.kind === "directory" ? "folder" : "file"}`}
          description={renameTarget.path}
          submitLabel="Rename"
          initialName={basenamePath(renameTarget.path)}
          onSubmit={(name) => {
            setRenameTarget(null);
            commitRename(renameTarget, name);
          }}
          onClose={() => setRenameTarget(null)}
        />
      )}
      <AlertDialog
        open={pasteConflict !== null}
        onOpenChange={(open) => {
          if (!open) setPasteConflict(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Paste blocked to protect existing files</AlertDialogTitle>
            <AlertDialogDescription>
              {pasteConflict?.paths.length === 1
                ? `"${pasteConflict.paths[0]}" already exists or would contain itself. ${pasteConflict.operation === "copy" ? "Copy" : "Move"} did not overwrite anything.`
                : `${pasteConflict?.paths.length ?? 0} destinations already exist or would contain themselves. ${pasteConflict?.operation === "copy" ? "Copy" : "Move"} did not overwrite anything.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" />}>Close</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={deleteTargets !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargets(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget
                ? `Delete "${basenamePath(deleteTarget.path)}"?`
                : `Delete ${deleteTargets?.length ?? 0} items?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "directory" && deleteContentsCount > 0
                ? `This will permanently delete the folder and everything inside it (${deleteContentsCount} item${deleteContentsCount === 1 ? "" : "s"}).`
                : deleteTargets !== null && deleteTargets.length > 1
                  ? "This will permanently delete the selected items. This action cannot be undone."
                  : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (deleteTargets === null) return;
                const targets = deleteTargets;
                setDeleteTargets(null);
                commitDelete(targets);
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
