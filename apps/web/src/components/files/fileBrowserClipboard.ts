import type { EnvironmentId } from "@t3tools/contracts";

export interface FileBrowserClipboard {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly operation: "copy" | "cut";
  readonly sourcePaths: readonly string[];
}

// The browser Clipboard API cannot reliably carry filesystem entries, so this
// intentionally lives only in the running T3 Code client.
let clipboard: FileBrowserClipboard | null = null;

export function getFileBrowserClipboard() {
  return clipboard;
}

export function setFileBrowserClipboard(value: FileBrowserClipboard | null) {
  clipboard = value;
}
