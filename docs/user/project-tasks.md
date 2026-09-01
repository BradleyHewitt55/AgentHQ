# Project tasks

Tasks belong to a project and appear in that project's **Tasks** right-panel surface. They live on
a **GitHub Projects v2 board**, which is the source of truth — nothing is stored locally, so what
you see here is exactly what is on GitHub.

## Boards and items

When you open Tasks, T3 Code looks up the boards available to the project's GitHub repository:
boards explicitly linked to the repository come first, followed by boards owned by its owner. The
first board with a usable **Status** column is picked automatically; if several boards are found,
the list response exposes all of them so clients can offer a picker.

Three kinds of items appear together on the board:

- **Drafts** — Project-native draft issues (`DraftIssue`). They exist only inside the board and are
  labelled _Draft_.
- **Issues** — repository issues added to the board, keeping their number, URL, repository, and
  open/closed state.
- **Pull requests** — PRs added to the board render like issues.

Board columns map onto the board's own Status options ("Todo", "In Progress", …). Items whose
status option is unrecognized fall back to Todo, or Done when closed.

## Creating tasks

Tasks are created with a title and an optional description (choose **Description** in the composer).

- **Draft** creates a draft directly on the selected board via GitHub's Projects v2 API.
- **Issue** files a real issue in the project's repository and adds it to the board in one step.
- A draft can be converted into an issue later with the promote action; GitHub keeps the same
  board item and gains an issue number and URL.

Select one or more task checkboxes and choose **Pass to agent** to add a combined handoff prompt
to the chat composer; passed tasks move to **In progress** on the GitHub board.

Deleting a task removes only the item from the board — the underlying issue stays untouched.

## Requirements

GitHub access goes through the `gh` CLI. Reading boards requires the `read:project` scope and
writing requires `project`; if they are missing, run:

```
gh auth refresh -h github.com -s read:project,project
```
