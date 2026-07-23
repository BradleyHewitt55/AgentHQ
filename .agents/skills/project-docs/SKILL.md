---
name: project-docs
description: Write or update project documentation (architecture docs, service docs, glossary, getting-started, plans). Use whenever creating docs, documenting a decision, a service, or a flow, or when AGENTS.md says "update the docs".
---

# Writing project docs

Method borrowed from a reference repo that documents everything from architecture to per-service guides. The core idea: **every doc has one audience, one job, and every claim is anchored to a real file path.** Docs that can't point at code are opinions, not docs.

## Folder map

Docs live in `docs/`, organized by audience/purpose, with `docs/README.md` as a thin index (one link per category, nothing else):

| Folder                   | Job                                        | Audience                  |
| ------------------------ | ------------------------------------------ | ------------------------- |
| `docs/GettingStarted.md` | Runnable commands only, comments as prose  | New dev                   |
| `docs/Architecture/`     | How the system fits together + decisions   | Maintainer                |
| `docs/Services/`         | One doc per plugin/service                 | Consumer of the service   |
| `docs/Reference/`        | Glossary, workspace layout, scripts        | Anyone confused by a term |
| `docs/Operations/`       | CI, release, checklists                    | Whoever ships             |
| `.plans/`                | Numbered design plans (pre-implementation) | Agent/dev doing the work  |

Create a folder only when the first doc for it exists. Keep `docs/README.md` in sync when you add one.

## Architecture docs (`docs/Architecture/`)

Structure, in order:

1. **One-sentence identity** — what the thing _is_, bold key terms. No preamble.
2. **ASCII box diagram** of the process/component topology, with transport labels on the arrows (`WebSocket`, `stdio`, `HTTP`).
3. **Components** — bulleted, `**Bold name**: one responsibility sentence.` Include the key constraint, not just the role ("schema-only — no runtime logic").
4. **Lifecycle flows** — one `mermaid` sequenceDiagram per flow (startup, request, async completion), each followed by a **numbered prose walkthrough** of the same steps.
5. **Reference-style links** — every component name in the walkthrough links to its source file. Collect the targets at the bottom:

   ```markdown
   1. The host loads plugins via [`PluginLoader`][1] and registers each in [`ServiceCollection`][2].

   [1]: ../../Projects/Host/PluginLoader.cs
   [2]: ../../Projects/Abstractions/ICompanyHqPlugin.cs
   ```

   This is the single most important habit: the doc becomes navigable and self-verifying — a dead link means the doc is stale.

Decision docs (like `Plugins.md`) keep the existing `## Decision` format: the decision in one sentence, then bulleted consequences with bold leads. When a decision changes, edit the doc in the same change as the code.

## Service docs (`docs/Services/<Name>.md`)

One doc per plugin/service. Since all services are headless plugins, the doc is written for the _consuming host_, and it's scenario-driven, not API-driven:

1. **Who this is for** — one line ("This guide is for hosts that need X").
2. **Scenario headings phrased as the reader's intent**: "I only need the default setup", "I want two isolated instances", "I want to swap the storage backend". Under each: the exact config, verbatim, in fenced blocks — not described in prose.
3. **Verification** — how the reader confirms it worked (a command, a log line, a page to open).
4. **Common mistakes** — bulleted list of the traps you know about, each with the fix.
5. **Upstream links** at the end for anything that changes over time, instead of duplicating volatile detail.

## Glossary (`docs/Reference/Encyclopedia.md`)

A living glossary, added to whenever a doc or PR coins a term. Per term:

- `#### Term` heading, grouped under `### Concept area` sections, with a table of contents.
- One–two sentences: what it means _in this codebase_, grounded in a linked file ("In [the contracts][1], a thread holds…").
- Concrete examples of real values (`thread.created`, `checkpoint.diff.finalized`) — examples disambiguate faster than definitions.
- Cross-link to the deeper doc (`See [workspace-layout.md][2]`).

## Reference: workspace layout

One bullet per project/package: `path`: role sentence + the one constraint that trips people up. Nothing else.

## Plans (`.plans/`)

Design docs for work not yet done. Numbered (`01-`, `02-`…), indexed in `.plans/README.md`. Structure: `## Goal` (what and why, two paragraphs max) → `## Scope` (exact files/services to touch) → `## Non-Goals` (explicitly bounded — this section is what keeps agents from over-building) → domain model / interface sketches in fenced code. Plans are disposable; durable outcomes graduate into `docs/`.

## Style rules (all docs)

- Brevity is a feature. If a doc fits in 5 bullets, it's 5 bullets (see any operations doc).
- Every file, command, and setting is written exactly, in backticks or fenced blocks — never paraphrased.
- Bold the term being defined; define it once, link to it everywhere else.
- Diagram + numbered prose is the pattern for any flow: diagram for shape, prose for the links.
- No changelog prose ("we recently changed…"). Docs state the present tense truth.
- When code and doc disagree, fixing the doc is part of the code change, not a follow-up.
