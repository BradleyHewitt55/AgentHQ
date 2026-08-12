import type { Dispatch, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const tree = vi.hoisted(() => {
  let addListener: ((event: { path: string }) => void) | null = null;
  const model = {
    add: vi.fn((path: string) => addListener?.({ path })),
    closeSearch: vi.fn(),
    getItem: vi.fn(() => undefined),
    getSelectedPaths: vi.fn(() => []),
    onMutation: vi.fn((_type: string, listener: (event: { path: string }) => void) => {
      addListener = listener;
      return () => {
        addListener = null;
      };
    }),
    remove: vi.fn(),
    resetPaths: vi.fn(),
    scrollToPath: vi.fn(),
    setGitStatus: vi.fn(),
    startRenaming: vi.fn(() => true),
  };

  return {
    config: null as Record<string, unknown> | null,
    model,
    reset() {
      addListener = null;
      this.config = null;
      for (const method of Object.values(model)) {
        if (typeof method === "function" && "mockClear" in method) method.mockClear();
      }
    },
  };
});

const commands = vi.hoisted(() => ({
  calls: 0,
  mkdir: vi.fn(() => Promise.resolve({ _tag: "Success" })),
  moveEntry: vi.fn(() => Promise.resolve({ _tag: "Success" })),
  reset() {
    this.calls = 0;
    this.mkdir.mockClear();
    this.moveEntry.mockClear();
    this.writeFile.mockClear();
  },
  writeFile: vi.fn(() => Promise.resolve({ _tag: "Success" })),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  let effects: Array<() => void | (() => void)> = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
      effects = [];
    },
    getEffects() {
      return effects;
    },
    reset() {
      cursor = 0;
      slots = [];
      effects = [];
    },
    useCallback<T>(callback: T) {
      nextIndex();
      return callback;
    },
    useEffect(effect: () => void | (() => void)) {
      nextIndex();
      effects.push(effect);
    },
    useId() {
      return `test-id-${nextIndex()}`;
    },
    useMemo<T>(factory: () => T) {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number) {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T) {
      const index = nextIndex();
      if (!slots[index]) slots[index] = { current: initialValue };
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useId: hooks.useId,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});
vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));

vi.mock("@pierre/trees/react", () => ({
  FileTree: () => null,
  useFileTree: (config: Record<string, unknown>) => {
    tree.config = config;
    return { model: tree.model };
  },
  useFileTreeSearch: () => ({ close: vi.fn(), setValue: vi.fn(), value: "" }),
}));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: Symbol("createUrl") } }));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => null }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: Symbol("open") } }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    deleteEntry: Symbol("deleteEntry"),
    mkdir: Symbol("mkdir"),
    moveEntry: Symbol("moveEntry"),
    writeFile: Symbol("writeFile"),
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => {
    const command = commands.calls++;
    if (command === 0) return commands.writeFile;
    if (command === 1) return commands.mkdir;
    if (command === 2) return commands.moveEntry;
    return vi.fn(() => Promise.resolve({ _tag: "Success" }));
  },
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("./fileTreeDragMention", () => ({
  createFileTreeDragMentionController: () => ({
    deselect: vi.fn(),
    getDraggedPaths: () => [],
    handleDragEnd: vi.fn(),
    handleDragStart: vi.fn(),
    handleSelectionChange: vi.fn(),
    isDragInProgress: () => false,
  }),
}));
vi.mock("./projectFilesQueryState", () => ({
  useProjectEntriesQuery: () => ({
    data: { entries: [], truncated: false },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

import FileBrowserPanel from "./FileBrowserPanel";

class RenameInput {
  dataset = { itemRenameInput: "true" };

  constructor(readonly value: string) {}
}

function findElement(
  node: unknown,
  predicate: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (node === null || typeof node !== "object") return null;
  if ("props" in node && node.props && typeof node.props === "object") {
    const props = node.props as Record<string, unknown>;
    if (predicate(props)) return props;
    const child = findElement(props.children, predicate);
    if (child) return child;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  }
  return null;
}

function mount() {
  hooks.beginRender();
  const element = FileBrowserPanel({
    cwd: "/workspace",
    environmentId: "environment-test" as never,
    onCloseFile: vi.fn(),
    onOpenFile: vi.fn(),
    projectName: "Test workspace",
    selectedPath: null,
    selectedPathRevealId: 0,
    threadRef: "thread-test" as never,
  });
  const surface = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const surfaceProps = findElement(
    element,
    (props) => props.className === "flex min-h-0 flex-1 flex-col overflow-hidden",
  );
  expect(surfaceProps).not.toBeNull();
  (surfaceProps?.ref as { current: unknown }).current = surface;
  hooks.getEffects().at(-1)?.();
  const toolbar = findElement(
    element,
    (props) => typeof props.onNewFile === "function" && typeof props.onNewFolder === "function",
  );
  expect(toolbar).not.toBeNull();

  return {
    surface,
    startDraft: (kind: "file" | "folder") => {
      const handler = kind === "file" ? toolbar?.onNewFile : toolbar?.onNewFolder;
      (handler as (() => void) | undefined)?.();
    },
  };
}

describe("FileBrowserPanel inline create", () => {
  beforeEach(() => {
    commands.reset();
    hooks.reset();
    tree.reset();
    vi.stubGlobal("HTMLInputElement", RenameInput);
  });

  it.each(["file", "folder"] as const)(
    "discards an untouched %s draft when focusout precedes Pierre's synchronous rename commit",
    async (kind) => {
      const { surface, startDraft } = mount();
      startDraft(kind);
      const focusout = surface.addEventListener.mock.calls.find(
        ([type]) => type === "focusout",
      )?.[1] as ((event: { composedPath: () => RenameInput[] }) => void) | undefined;
      expect(focusout).toBeDefined();

      focusout?.({ composedPath: () => [new RenameInput("untitled")] });
      (tree.config?.renaming as { onRename: (event: Record<string, string>) => void }).onRename({
        destinationPath: "untitled",
        sourcePath: "untitled",
      });
      await Promise.resolve();

      expect(tree.model.remove).toHaveBeenCalledWith(kind === "folder" ? "untitled/" : "untitled");
      expect(commands.writeFile).not.toHaveBeenCalled();
      expect(commands.mkdir).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["file", "notes.ts"],
    ["folder", "notes"],
  ] as const)("creates a %s when its inline edit commits a name", (kind, name) => {
    const { startDraft } = mount();
    startDraft(kind);

    (tree.config?.renaming as { onRename: (event: Record<string, string>) => void }).onRename({
      destinationPath: name,
      sourcePath: "untitled",
    });

    const command = kind === "file" ? commands.writeFile : commands.mkdir;
    expect(command).toHaveBeenCalledWith({
      environmentId: "environment-test",
      input: { cwd: "/workspace", relativePath: name, ...(kind === "file" && { contents: "" }) },
    });
  });

  it("keeps ordinary renames as moves", () => {
    mount();

    (tree.config?.renaming as { onRename: (event: Record<string, string>) => void }).onRename({
      destinationPath: "after.ts",
      sourcePath: "before.ts",
    });

    expect(commands.moveEntry).toHaveBeenCalledWith({
      environmentId: "environment-test",
      input: { cwd: "/workspace", fromPath: "before.ts", toPath: "after.ts" },
    });
  });
});
