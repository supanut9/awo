# State and evidence stabilization

This patch fixes concurrency, governed completion, evidence retries, tested-tree
identity, historical diagnostics and package provenance. It does not add delivery
groups, release obligations or scheduled work; those remain separate proposals.

## Runtime behavior

- State mutations and daily Markdown record replacements hold a filesystem lock
  across the whole read/modify/write operation. Replacement uses a unique temporary
  file and rename. Concurrent runs reserve their readable IDs before writing events;
  reservations live under `.workspace/run-id-reservations/` and survive a crashed caller.
- A task-complete goal lacking required criterion evidence or QA appears as
  `qa-review`. List, context, UI and normal archival use the readiness evaluator.
  Legacy goals without strict completion policy retain their old contract.
- Reattaching identical evidence preserves QA. Changed evidence retains the prior
  verdict in `qaHistory` and requires verification again. That history is currently
  available in state; this patch does not add a history UI.
- Test events resolve the checkout recorded when the run started. They refuse a
  missing checkout instead of silently testing the shared repository. For legacy
  runs without sufficient provenance, supply `--checkout <path> --base <ref>`.
  Rechecks preserve the earlier comparison base.
- Each measurement records checkout, head/base SHA, working-tree fingerprints and
  an immutable JSON artifact containing candidate and baseline results. Output is
  the existing capped tail, not a full transcript. Dirty/untracked source participates
  in classification, Git errors fail closed, and changes during a command require
  re-verification. A fingerprint excludes Git-ignored files and is not an environment
  fingerprint; it is not sufficient for automatic cross-task test reuse.
- Completion checks the latest measurement of every repo/command pair. A failed
  or timed-out check blocks success, including `--gate`; a successful rerun of the
  same command replaces the failure. Git receipts must still match the current
  checkout, and commands that changed their own tested tree must be rerun.
  Legacy/non-Git receipts without fingerprints retain their existing limitations.
- `doctor --scope active` focuses on live goals. Default `--scope all` retains
  historical diagnostics, but an unregistered target in an archived goal is
  information rather than an active-work error. `doctor --json` emits structured
  findings with the same exit-code policy. This does not certify that a repository
  or deployed service was safely retired.
- `version --verbose` (or `version --json`) reports the executable and build metadata:
  package version, source commit, dirty-source flag and source hash. Metadata contains
  no wall-clock timestamp, so the same inputs produce the same metadata. A missing
  metadata file is shown explicitly as `build: null` for older builds.

## Rollout and recovery

1. Back up the workspace, including ignored state and logs. Stop all AWO writers
   before switching builds; older binaries do not honor the new locks. Source
   compatibility does not make mixed-version concurrent writing safe.
2. Build and test the selected source, verify its packed CLI in a disposable
   workspace, and check `version --verbose`. Do not infer release identity from
   the manifest version alone.
3. Run read-only `doctor`, `context` and selected `goal readiness` checks on the
   target workspace before resuming work. A newly visible QA blocker is not a reason
   to fabricate evidence or silently force archival.

Locks are never stolen based on age. A paused process might still be writing.
After 30 seconds a waiting command reports the lock path, owning PID and hostname.
For a confirmed interrupted owner, stop every writer, inspect `owner.json`, verify
the owner has exited on the named host, remove only that lock directory, and retry.
Retain the protected state/log file and run-ID reservations. Orphan unique temporary
files from a killed writer are not authoritative state and can be removed during
that same stopped-writer recovery. Never remove a lock merely because it is old.

For an ordinary rollback, stop writers first and preserve the new reservations and
evidence. The old build cannot enforce the new concurrency guarantees. Do not run it
concurrently or interpret its task-only `done` rollup as acceptance.

## Validation

Regression coverage includes multiple processes mutating one goal, overlapping ID
allocation across midnight, concurrent log replacements, rejected mutations,
interrupted lock owners, identical evidence retries, missing-QA archival, dirty
source/test attribution, custom checkout selection and historical doctor severity.
The legacy integration suite remains required alongside these tests.
