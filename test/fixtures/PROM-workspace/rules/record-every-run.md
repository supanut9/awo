---
id: record-every-run
name: Every piece of work leaves a log entry
appliesTo: [task_completion, requirement, goal, audit]
severity: required
summary: every piece of work leaves a log entry; non-task work uses `awo log add`.
---

Work that is not recorded did not happen, as far as the audit trail is
concerned. Before you report finishing anything, make sure it left a log entry.

- **Task work:** `awo task run` opens the run and `awo task complete` closes it,
  writing the log for you. Report progress in between with `awo task event` so
  the record shows *what* happened, not just that something did.
- **Everything else — intake, planning, QA verdicts, audits, one-off prompts:**
  nothing logs it automatically. Finish with
  `awo log add --agent <your-role> --summary "<what you did>"`, adding
  `--prompt`, `--interpreted`, `--note`, `--model`, and `--repo` where they
  apply. `taskId` is null for this kind of work, which is expected.

Never hand-write files under `logs/`. Use the commands so the index, the detail
file, and their ID all stay consistent.
