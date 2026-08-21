# Project files

The project file browser in the right panel can copy, cut, and paste selected files or folders.

Expanded folders are remembered per project and restored the next time you open **Files**. Ignored
folders remain dimmed, but can still be expanded to inspect their contents.

- Use the file or folder context menu, the accessible toolbar buttons, or `mod+c`, `mod+x`, and `mod+v` while the file tree has focus. `mod` is Command on macOS and Control elsewhere.
- Paste into a selected folder; with no folder selected, paste goes to the project root. Folder copies retain their full hierarchy.
- T3 Code never overwrites an existing destination. It shows a conflict dialog instead, and does not perform a partial multi-file paste.
- File clipboard entries are **app-local memory**, scoped to the current project. Browsers cannot reliably read or write operating-system filesystem clipboard entries, so copying files in Finder/Explorer cannot be pasted here, and the app-local clipboard is lost when the client reloads.
