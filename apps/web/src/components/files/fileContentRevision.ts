export function fileContentRevision(contents: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${contents.length}:${(hash >>> 0).toString(36)}`;
}

export function projectFileCacheKey(cwd: string, relativePath: string, contents: string): string {
  return `${cwd}:${relativePath}:${fileContentRevision(contents)}`;
}

export class EditableFileCacheKey {
  readonly #cwd: string;
  readonly #relativePath: string;
  #editorContents: string;
  #renderedContents: string;
  #cacheKey: string;

  constructor(cwd: string, relativePath: string, contents: string) {
    this.#cwd = cwd;
    this.#relativePath = relativePath;
    this.#editorContents = contents;
    this.#renderedContents = contents;
    this.#cacheKey = projectFileCacheKey(cwd, relativePath, contents);
  }

  localChange(contents: string): void {
    this.#editorContents = contents;
  }

  resolve(contents: string): { readonly cacheKey: string; readonly contents: string } {
    if (contents !== this.#editorContents) {
      this.#editorContents = contents;
      this.#renderedContents = contents;
      this.#cacheKey = projectFileCacheKey(this.#cwd, this.#relativePath, contents);
    }
    return { cacheKey: this.#cacheKey, contents: this.#renderedContents };
  }
}
