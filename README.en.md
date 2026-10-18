# dsh-agent-team-roster

Agent Teams roster administration for the Team Lead, without patching the shipped
`@deepseek-ai/dsh-experimental-agent-team` package: **rename a teammate**, **delete a
teammate**, a **newest-first display order** for the roster, the shared task board and
the subagent conversation catalog, and a **bulk `cleanup_team`** tool. Installs as one
Cordis bundle row into the `web` profile.

## What it adds

- `rename_teammate { target, new_name }` — rename one settled teammate in place.
  It keeps its history, session, context, tasks, and pending mail; the new name
  becomes its address and the old name is free again. The teammate is not
  notified, so a Lead that wants it to answer to the new name must message it.
- `delete_teammate { target }` — stop the member's current turn, release its
  runtime, release its unfinished shared tasks, drop its undelivered inbox, and
  free its name. Durable history and the child Session log are kept; only the
  roster row goes away.
- `cleanup_team { scope }` — bulk cleanup with `scope` one of `teammates`
  (every teammate whose turn is not running), `tasks` (every completed shared
  task), or `all`. It deletes through exactly the same service paths as
  `delete_teammate` and `team_task_update`, so a running teammate, a teammate
  still provisioning, an unfinished task, and a task that still blocks another
  task are left alone and reported in `skipped`.
- Newest-first display order for the Team roster, the shared task board, and the
  subagent conversation catalog: the Lead row stays first as the panel anchor,
  and every teammate, task, and child conversation after it renders newest
  first. Only the client-facing view changes.
- One system-prompt section, `team:grounding`, in every Team member's scope:
  report only what an artifact supports, re-derive it yourself, and state what
  you did not verify.

Values: rename returns `{ previousName, name, status }`; delete returns
`{ name, previousStatus, releasedTasks[], discardedMessages[] }`; cleanup returns
`{ scope, teammates[], tasks[], releasedTasks[], skipped[{ kind, target, reason }] }`. Both refuse a
`provisioning` member with `TEAM_MEMBER_BUSY` and a non-Lead caller with
`TEAM_LEAD_REQUIRED`. Rename also refuses `TEAM_INVALID_TARGET` (the Lead),
`TEAM_MEMBER_NOT_FOUND`, `TEAM_INVALID_MEMBER_NAME`, `TEAM_MEMBER_NAME_TAKEN`;
delete also refuses `TEAM_INVALID_TARGET` and `TEAM_MEMBER_NOT_FOUND`. Renaming
to the current name returns the same name and appends no event.

## How it works

The packaged Agent Teams package owns the durable roster: a teammate exists
while the folded `agentTeam` session projection keeps a member row, and that
fold treats `name` as an immutable identity field. The fold is private, so this
plugin extends the **live projection unit in place** instead of copying or
patching the package:

- `installRosterFold(ctx.sessionProjections)` wraps
  `sessionProjections.registrations.get('agentTeam').def.apply`, so two roster
  mutations become expressible as new values of the existing `team/member`
  event type:
  - a member payload with `renamedTo` renames that member and keeps its real
    phase, so readers see an ordinary active (or failed) row under the new name;
  - a member payload with `phase: "removed"` drops that member row and its
    undelivered mail.
  Every other event is delegated to the packaged fold, so every existing reader
  (roster, mailbox, task board, tools, client view) sees the change without
  knowing about this plugin. State shape and `stateVersion` stay official, and
  task `ownerName` is derived from the roster, so a rename updates ownership
  display by itself.
- `renameTeammate` and `removeTeammate` each perform one mutation through the
  live service only: `membership` (Lead check), `journal.state` (name
  resolution), `roster.memberName` (the packaged name rule), `ctx.agents.get`
  (liveness), and — for deletion — `ctx.subagents.interrupt`, `updateTask(action:
  'release')` per unfinished task, the target's in-flight `mailbox.dispatchTails`
  entry, `ctx.subagents.drainContinuableChildren`. Every rule is checked before
  the durable append, so an invalid request can never freeze the projection.

Three design decisions worth knowing:

- The mutations are recorded as **new values of an existing event type**
  (`team/member`), not as a new event type, because a plugin cannot append a new
  type: an unrecognized stored type is only accepted when its writer can mark it
  `ignorable`, which the live `Session.append()` cannot.
- A rename keeps `phase` truthful and carries the intent in `renamedTo`, rather
  than inventing a `renamed` phase: a phase is a lifecycle state, and the plugin
  rewrites the stored row back to its real phase anyway.
- A failed runtime drain is logged as a warning instead of raised: the deletion
  is already durable at that point, so failing the call would misreport it.
- Registering a scope is atomic: if the second registration throws, the plugin
  undoes the first and rethrows. A half-installed scope would otherwise leave a
  section or tool name owned by a dead fiber and block the next activation of
  this plugin, which is exactly what happened during development and is now
  covered by `test/run-wiring.mjs`.

- `installDisplayOrder(ctx.sessionProjections)` wraps the `wire.view` of the
  registered `agentTeam` and `subagentCatalog` units. The wire view is the value
  the client receives (`dsh-session-projection` builds it as
  `wire.viewSchema.parse(wire.view(state))`, including for cached checkpoints
  through `viewCheckpoint`), so reordering it changes what the roster panel, the
  task board, and the child-conversation catalog render, while fold state,
  `stateVersion`, service contracts (`listTasks` keeps numeric creation order),
  and stored values stay packaged. A missing `agentTeam` wire view fails
  activation; a missing `subagentCatalog` one warns and orders the Team view
  only. The ordered value is memoized by the packaged view's reference, so an
  unchanged packaged value yields one unchanged ordered value: a state change
  the packaged unit ignores (a mailbox-only Team change) still republishes
  nothing, exactly as the packaged unit documents. Treat the ordered value as
  read-only, as with the packaged value it replaced: it is the same object the
  packaged unit hands out, and the shipped client only maps over it.

## Install

```bash
# from the harness, with Full access:
plugin_manager install_bundle target=/root/dsh-agent-team-roster
```

The profile resolves the plugin through a `link:` dependency, the same way the
other local bundles in `~/.dsh/profiles/web/package.json` are installed. The
profile sets `patchReload: startup`, so **a dsh restart activates the row**.

The package declares no `dependencies` and no `@deepseek-ai/dsh-*`
`peerDependencies`, so installation needs no registry and no version exemption,
and a dsh upgrade does not block it. Its imports
(`@deepseek-ai/dsh-experimental-agent-team`, `@deepseek-ai/dsh-tools`) resolve
through the `node_modules` symlink in this directory, which points at the dsh
installation's own `node_modules`; keep that symlink next to the package,
because the plugin file's realpath is where module resolution starts.

**Do not run this plugin together with the hand-patched fork.** The patched
`dsh-experimental-agent-team` / `dsh-experimental-tool-agent-team` copies in
`/root/dsh-agent-team-delete/` also register `delete_teammate`, and two
registrations of one tool name in one Agent scope make the row fail to activate
(`tool "delete_teammate" is already registered in this scope`). Keep the shipped
modules pristine while this plugin is installed.

## Verification

`test/run-tests.mjs` (64 tests) runs the shipped `lib/index.js` against the
**pristine** packaged core (`test/core-pristine.js`, md5-checked against
`512150bb996ca45cde8a5b6ea298e35a`), the **real**
`@deepseek-ai/dsh-session-projection` registry, and the real Agent Teams
service/journal over fake runtime services. `test/run-wiring.mjs` (14 tests)
drives the real `apply(ctx)` and all three registered tools through the real
`defineTool`. `test/run-mount.mjs` mounts the plugin against the **real**
`Tools` (`ToolRuntime`) and `SystemPrompt` services next to the real registry and
team service, then renames, deletes, and cleans up members through `ctx.tools`,
which is what a live activation does. Build the pristine copy with
`node test/build-pristine.mjs` before running any suite.

Covered for deletion: member dropped for `active`/`failed` and refused for
`provisioning`, state shape unchanged, name reusable afterwards, undelivered
mail dropped while delivered mail is kept, a late `team/message/delivered`
acknowledgement tolerated, an unknown-message acknowledgement for a live target
still failing, foreign-team and other-domain events untouched, task release
through the public API, interrupt/drain calls, result shape, refusal codes,
mailbox consequence (`TEAM_MEMBER_NOT_FOUND` on send), drain failure logged not
raised.

Covered for rename: name and row rewritten with phase, description, provider,
and context kept, `renamedTo` absent from the stored row, `active` and `failed`
members accepted and `provisioning` refused, a name in use refused, a payload
that rewrites immutable fields refused, an unknown member refused, the current
name a no-op that appends nothing, messages and delivered mail untouched, task
`ownerName` updated while status and revision stay, no interrupt or drain call,
the old name no longer addressable, the freed name reusable by a new member, a
foreign-team rename ignored, and a non-string `renamedTo` left to the packaged
fold, which rejects it.

Covered for display order: the Lead row stays first while teammates render
newest first, tasks render newest first, catalog entries render newest first by
child creation time, the packaged view is never mutated, the reordered Team view
still passes the packaged wire schema, the service contract still reports numeric
creation order, a second install is inert, one disposer restores both packaged
views, a missing `agentTeam` wire view throws, a missing catalog wire view warns
while the Team view is still ordered, an unchanged packaged value keeps one
ordered reference, and an ignored state change still republishes nothing (a
mailbox-only Team change, exercised against the real service in the mount
suite). Also covered: a second `apply(ctx)` in one context fails loudly at the
tool layer and leaves the first activation's fold wrapper, wire views, and tools
working.

Covered for cleanup: a settled teammate and a completed task are deleted while a
running teammate is skipped with its reason, an unfinished task survives, a
completed task owned by a teammate is deleted after its owner, an unfinished task
owned by a deleted teammate is released and reported, an unknown scope is
rejected by the tool parameters and by the service guard, and scope `teammates`
leaves tasks alone.

Covered for replay: a fresh projection cell over a log with a rename, and over a
rename followed by a removal, folds cleanly; an unwrapped reader freezes on
either payload. Covered for wiring: one grounding section plus one of each tool
per Team member scope, idempotent per Agent, stale identities skipped, all three
tools executable through the real service, every result rendering as compact
JSON, `TEAM_LEAD_REQUIRED` enforced for a teammate caller, and a mid-install
failure undoing the registrations, the fold wrapper, and the wire-view wrappers
it already made.

## Limits

- A dsh build **without** this plugin that reads a session log containing either
  payload freezes that session's Team projection (`failure`), because the
  packaged member schema is strict. This is verified, not inferred:
  `test/run-tests.mjs` asserts the unwrapped reader behavior. Session history is
  unaffected; only Team state for that session.
- A renamed teammate keeps calling itself by the old name until the Lead tells
  it otherwise: the name is baked into the prompt that created it.
- The extension depends on internal seams (`sessionProjections.registrations`,
  the `agentTeam` unit's `def.apply`, `journal`/`mailbox`/`roster` fields). It
  feature-detects the projection table and the roster name rule and fails loudly
  at activation rather than installing tools that cannot work.
- **A subagent conversation cannot be deleted.** dsh exposes no session-deletion
  API, so cleanup covers the roster row and the shared tasks; the child
  conversation stays in the catalog and the Session log remains. Only the
  ordering applies to that catalog.
- The catalog seam is verified against a faithful registration in
  `test/run-wiring.mjs`. The shipped `subagentCatalog` unit registers from
  `dsh-subagent` only with the session-query service present, which is not
  constructible standalone here, so its live ordering is confirmed by looking at
  the header's descendant catalog.
- Ordering is display-only: the model-facing `list_agents` and `team_task_list`
  keep the packaged row order, because those read the service contracts, not the
  client view.
- Verified against dsh 0.2.0-rc.2 only. Live-verified on rc.2: roster, mailbox,
  and task consequences of rename and delete, deletion while a turn runs
  (interrupt observed), and name reuse. Still not live-run: `fork`-context
  members, the `team/message/discarded` non-empty path, and the client panels
  themselves (no browser control; the host-side values they render are what the
  suites assert).
