# 5. Note mutations (create / rename / move) and the leaf↔parent transition

- Status: Accepted
- Date: 2026-06-15
- Issue: #7 (Create, rename, and move notes, with the leaf↔parent transition)

## Context

The note tree (ADR 0001) is read-only so far: `core/note-tree` maps a flat set
of Markdown files *into* the hierarchy, and edits change a note's *content*
(commit-on-save, ADR 0003; autosave, ADR 0004) but never its *shape*. Users need
to **create** new notes, **rename** them, and **move** them around the tree —
and, because "folders are first-class notes" (ADR 0001), those operations have to
carry the **leaf↔parent transition** that ADR 0001 promised but deferred:

- Giving a **leaf** its first child must turn `Foo.md` into `Foo/_index.md` so the
  child has somewhere to live — without changing the parent's `path` identity.
- Removing a **parent's** last child is the symmetric inverse: `Foo/_index.md`
  collapses back to `Foo.md`.
- Moving or renaming a **parent** must carry its whole subtree (`_index.md` and
  every descendant) as one unit.

Several things need deciding:

1. **Where the structural logic lives.** Computing which files move/create/remove
   for a given operation (including the transitions) is pure tree reasoning, but
   the actual `git mv` / `git add` / `git rm` is Node-and-git IO. ADR 0001's split
   — pure mapping in `core`, IO in `apps/server` — must hold here too.
2. **Atomicity.** A move that promotes a destination, relocates a subtree, and
   collapses the emptied source touches many files; a half-applied move would
   corrupt the tree. It must be one commit, all-or-nothing.
3. **Collapse policy.** Promotion is unambiguous (a leaf gaining a child *must*
   become a directory). Collapse is a *choice*: when a parent loses its last
   child, do we auto-collapse it to a leaf, or leave an empty `Foo/_index.md`
   directory note?
4. **The HTTP surface.** One combined "mutate" endpoint, or one per operation?

## Decision

### A pure planner + an atomic engine seam (`core/note-mutation`)

- The structural logic is a **pure planner**: `planCreateNote` / `planRenameNote`
  / `planMoveNote` take the current file set and an operation and return a
  `NoteMutation` — plain data describing the backing-file `moves` (each a `file`
  or whole-`dir` rename), `creates`, and `removes`, plus the resulting note
  `path`/`file` identity and a commit `message`. No IO, no git. The planners are
  the write-side counterpart to `core/note-tree`'s read-side mapping, and are
  unit-tested by applying their plan to an in-memory file set
  (`applyNoteMutationToFiles`) and feeding the result back through `buildNoteTree`.
- The engine seam is a deliberately narrow `MutatingGitEngine`
  (`listNoteFiles` + `applyNoteMutation(mutation)`), mirroring
  `WritableGitEngine` / `WipGitEngine`. The thin compositions `createNote` /
  `renameNote` / `moveNote` read the current files, plan, and delegate the IO —
  the counterparts to `writeNote`.
- `applyNoteMutation` performs the whole plan as **one atomic commit** on `main`:
  run `moves` (`git mv`, mkdir-ing destinations), then `creates`, then `removes`,
  then a single `commit` — skipping the commit when the plan is a no-op. On *any*
  error the working tree is reset (`git reset --hard` + `git clean -fd`) so a
  half-applied mutation never lands. Every path is escape-guarded (a crafted
  `..`-path hard-fails rather than touching anything outside the clone).

### The leaf↔parent transition, composed into the plans

- **Promotion** is prepended whenever a destination/parent is currently a leaf:
  `Foo.md` → `Foo/_index.md`, then the child is created beside it. The parent
  keeps its `Foo` identity. This is automatic and non-negotiable — a leaf cannot
  hold a child.
- **Collapse** is the symmetric inverse and is **automatic**: when a move removes
  a parent's *last* child, the plan appends `Foo/_index.md` → `Foo.md`. The check
  is precise — it ignores the parent's own `_index.md` and the file/subtree being
  moved away, and only fires when no other descendant remains.
- Two guards keep collapse safe and meaningful: the **root note never collapses**
  (it is always a parent), and only a parent backed by a real `_index.md`
  collapses — never an "implied" parent. Promotion and collapse are thus exact
  inverses, so a create-then-move round-trips the tree's shape.

### Whole-subtree moves as a single directory rename

- Renaming/moving a parent emits one `dir` move (`Foo` → `Bar`), not a file-by-
  file rewrite. In the engine that is a single `git mv` of the directory, which
  carries `_index.md` and every descendant atomically; in the pure
  `applyNoteMutationToFiles` it is a prefix rewrite. The plan stays O(1) in size
  regardless of subtree depth.

### Three endpoints, one per operation

- `POST /api/note/create` (`{ parent, name }`), `POST /api/note/rename`
  (`{ path, name }`), `POST /api/note/move` (`{ path, parent }`), each returning
  the affected note's new `{ path, file }`. Three narrow verbs read better than
  one overloaded "mutate" with a discriminator, and map one-to-one to the
  acceptance criteria.
- A rejected mutation — invalid/blank name, a name colliding with an existing
  note, or moving a note into its own subtree — throws a typed
  `NoteMutationError` that the routes map to **400** (client error); any other
  failure stays **500**, mirroring how the read/write routes treat engine
  failures. Names are turned into safe kebab-case file slugs by `slugifyNoteName`
  (which round-trips back through `deriveTitle`).

### UI affordances (`packages/ui`)

- Each tree node carries a **+** (new child) affordance; non-root nodes also carry
  rename and move. The browser posts through `mutation-client`
  (`postNoteCreate` / `postNoteRename` / `postNoteMove`), then **reselects** the
  returned note `path` and bumps a reload token so `useTree` refetches the
  reshaped tree. A rejected mutation surfaces the server's message inline.

## Consequences

- **Structure changes are pure-planned and atomically applied.** The tree
  reasoning (including both transitions) is unit-tested offline against an
  in-memory file set; the real `git mv`/`add`/`rm` is tested against a temp clone.
  A failed mutation rolls back, so the tree is never left half-moved.
- **The leaf↔parent transition is finally realized, symmetrically.** Promotion and
  collapse are inverses computed in one place, so "folders are just notes with
  children" holds through every create/move — no orphaned empty directory notes,
  no special-cased UI for "convert to folder".
- **Collapse is automatic, which is an opinion.** Moving a parent's last child
  away silently turns it back into a leaf. This keeps the tree free of vestigial
  empty parents and is reversible (re-adding a child re-promotes it), but it means
  a user who *wanted* `Foo` to stay a (now childless) section note cannot express
  that — the model has no "empty parent" state to preserve. We accept this for the
  single-hierarchy, single-user target; an explicit "keep as section" affordance
  is the escape hatch if that ever bites.
- **Mutations commit to `main` on the clone and are not pushed**, consistent with
  ADR 0003/0004's deferred push: the structural commit lands on the working
  clone's `main` like every other write, and the eventual sync slice publishes it.
- **One working tree, serialized.** Like the wip lifecycle (ADR 0004), mutations
  operate on the single shared clone checked out to `main`; concurrent structural
  edits serialize through it. Acceptable for the desktop target now.
