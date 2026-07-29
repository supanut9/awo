# awo — the manual

A working guide to running a real project with AI agents through `awo`.

`README.md` is the overview and command reference. This is the how-and-why: the
sequence you actually follow, what each gate is for, and what to do when something
goes wrong.

- [1. The mental model](#1-the-mental-model)
- [2. Setting up a workspace](#2-setting-up-a-workspace)
- [3. Intake: from a wish to something approvable](#3-intake-from-a-wish-to-something-approvable)
- [4. Planning a goal](#4-planning-a-goal)
- [5. Doing the work](#5-doing-the-work)
- [6. Evidence, and deciding what a failure means](#6-evidence-and-deciding-what-a-failure-means)
- [7. The QA gate](#7-the-qa-gate)
- [8. Running many tasks at once](#8-running-many-tasks-at-once)
- [9. Where the human belongs](#9-where-the-human-belongs)
- [10. Customising the workspace](#10-customising-the-workspace)
- [11. Model tiering](#11-model-tiering)
- [12. Watching what happens](#12-watching-what-happens)
- [13. Upgrading](#13-upgrading)
- [14. Troubleshooting](#14-troubleshooting)
- [15. Before you use this on something that matters](#15-before-you-use-this-on-something-that-matters)

---

## 1. The mental model

An awo workspace is **not** where your code lives. It is the orchestration hub:
roles, rules, skills, the work hierarchy, and the audit trail. Your repos stay where
they are and get linked in.

```
Requirement  →  Goal  →  Tasks  →  Runs  →  Logs
 (the ask)      (the      (executable  (what actually
                objective) units)       happened)
```

Two ideas do most of the work:

**Files, not shared context.** Agents hand off through the filesystem, which is why a
Claude session can orchestrate Codex workers with no interop layer. `AGENTS.md` is
canonical; `CLAUDE.md` and `GEMINI.md` are pointers to it.

**Definitions and state are separate.** A task's markdown is tracked in git. Its
lifecycle status lives in a gitignored `state.json`, and each run appends to a log.
So a task's *status* (`todo · queued · running · blocked · in-review · done ·
cancelled`) is deliberately distinct from a run's *outcome* (`success · failed ·
skipped`) — work can be in review while its last build failed.

---

## 2. Setting up a workspace

```sh
mkdir my-workspace && cd my-workspace
npx @supanut9/awo@latest init --key SHOP
```

`--key` prefixes every ID (`SHOP-R1`, `SHOP-G1`, `SHOP-T1`) and is **permanent**.

Link your repos. `connect` symlinks a checkout you already have; `add` clones one:

```sh
awo connect ../learn-shop-online-server
awo add https://github.com/me/web.git --ref main
awo list
```

**Then declare how each repo verifies itself.** Do this now, not later:

```sh
awo test-command learn-shop-online-server "npx jest --silent"
awo test-command web "npm test"
```

Without it, every measurement carries an inline command, so each agent invents its
own — and an agent choosing the verification is the same failure as an agent
asserting the result. `awo doctor` reminds you until it's set.

Open the generated `SHOP.code-workspace` in VS Code rather than the folder: it carries
the git settings that make Source Control and Git Graph see every linked repo.

---

## 3. Intake: from a wish to something approvable

This is the one gate that cannot be delegated.

```
draft ──(PM role writes acceptance criteria)──▶ proposed ──(you)──▶ approved
                                                    └──────────────▶ rejected
```

**A vague ask** starts as a draft:

```sh
awo req new --title "FAQ section on the product detail page"
awo req refine SHOP-R1        # hands it to the product-manager role
```

`refine` prints a brief and an invocation. The PM agent fills in the raw ask,
clarifications, acceptance criteria and non-goals, then runs `awo req propose SHOP-R1`
— which **refuses** if the criteria are still the scaffold's placeholder.

**A requirement a real PM already wrote** skips refinement, not approval:

```sh
awo req new --title "Tax at checkout" --source jira:SHOP-123 \
            --body-file ./ticket.md --proposed
```

Either way, you read the criteria and decide:

```sh
awo req list
awo req approve SHOP-R1 --who supanut
awo req reject  SHOP-R1 --why "the versioning story isn't settled"
```

`awo goal new --from` refuses anything not approved. Rejection requires `--why`,
because one without a reason cannot be acted on. Both decisions are recorded as runs,
so the trail shows who authorised the work and on which criteria.

**Write criteria as Given / When / Then.** Not ceremony: that shape is also the shape
of a test, so criteria written this way turn into machine checks instead of adding to
your review pile.

```markdown
## Draft acceptance criteria
- Given a product with 3 published FAQs, when the PDP loads, then all 3 render in order
- Given an unpublished FAQ, when the PDP loads, then it is absent from the response
```

---

## 4. Planning a goal

```sh
awo goal new --from SHOP-R1          # moves the requirement in as requirement.md
awo task new --goal SHOP-G1 --name "FAQ data model" \
             --targets learn-shop-online-server --agent software-engineer
awo task new --goal SHOP-G1 --name "Public read endpoint" \
             --targets learn-shop-online-server --depends-on SHOP-T1
```

Two things to get right, because they are where defects actually concentrate:

**`--targets` is a rail, not a label.** Worktree isolation only covers repos listed
there. A repo mentioned only in a task's prose gets **no** worktree, so an agent that
goes looking will edit your real checkout on whatever branch it's on. List every repo
a task may touch, even if you expect no change.

**`--depends-on` defines the seams.** The integration boundary between two tasks is
the thing no worker can see, because each is on one side of it. This is the part worth
your attention at planning time.

---

## 5. Doing the work

Open a run. This creates the isolated worktree, resolves which model should do it, and
**records the brief the worker is given**:

```sh
awo task run SHOP-T1 --instruction "Use the existing pagination helper; add no deps."
```

`--instruction` is your message to that worker. It goes into the run's `brief` event,
so the log answers *what was this worker asked to do* — not just what it did.

Then either paste the printed invocation, or let awo spawn the worker and block until
it exits:

```sh
awo task dispatch SHOP-T1 --timeout 45
```

During the run, the agent records progress:

```sh
awo task event SHOP-T1 step.start --label "reading the layout config"
awo task event SHOP-T1 commit --label "584a55a feat(faq): add model"
awo task event SHOP-T1 test --run "npx jest --silent" --baseline
```

Close it:

```sh
awo task complete SHOP-T1 --outcome success --gate --summary "…"
```

`--gate` routes success to `in-review` instead of `done`. Use it whenever a human
should look.

---

## 6. Evidence, and deciding what a failure means

**awo runs the command; it does not accept a claim.**

```sh
awo task event SHOP-T3 test --run "npx jest --silent" --baseline
```

Exit code, duration and parsed pass/fail counts are recorded, plus the output tail on
failure. `awo task complete --gate` accepts **only** a measured pass. A `test` event
you typed is refused by name.

This matters more than it looks: published analysis of agent-authored test patches
found roughly **80% carry weak or no assertions** — existence checks, mock
verification, snapshots. "Tests passed" as prose is the weakest signal in the whole
workflow.

`--baseline` runs the same command at the branch point, in a throwaway worktree so the
agent's uncommitted work is never touched. That answers the question you actually
have:

| baseline | now | diagnosis | what it means |
|---|---|---|---|
| fails | fails, no worse | `pre-existing` | not this task's defect — **and not verification either** |
| passes | fails | `regression` | this change broke it |
| — | fails, new tests added | `new-contract` | the acceptance criteria decide |
| passes | passes, but a test **and its own code** changed together | `test-and-code-changed` | **inconclusive** |

The last row is the important one. A test edited into agreement with the code proves
nothing, and neither file can settle it — both moved. The tiebreak must be the artefact
that predates both: the goal's acceptance criteria. If those don't settle it, that's a
specification gap, and the task belongs in `blocked` with the question.

awo enforces this: a passing-but-inconclusive measurement **cannot** send a task
straight to `done`. It must go through `--gate`.

**A task closed before any of this existed** can be verified after the fact:

```sh
awo task recheck SHOP-T3 --run "npx jest --silent" --baseline
```

It opens a *new* run rather than editing the old one — evidence can't be retro-fitted
into an append-only log without turning the audit trail into a story. If the command
turns out to be red at the branch point, the run is `skipped` and the task is left
`blocked`, because a red base verifies nothing.

---

## 7. The QA gate

Per task:

```sh
awo task verify SHOP-T1              # in-review -> done
awo task verify SHOP-T1 --reject     # back to blocked, with a reason
```

Per goal — the one that catches what per-task checks cannot:

```sh
awo goal verify SHOP-G1               # assembles the brief for a high-tier review
awo goal trace SHOP-G1                # each acceptance criterion vs its evidence
awo goal verdict SHOP-G1 --pass --summary "meets the definition of done"
awo goal verdict SHOP-G1 --gap  --summary "FAQ ordering is not applied on the BFF route"
```

This exists because of a real result: six tasks each passed their own checks and
composed into a functionally broken feature. Only a cross-branch review at high effort
found it. **Per-task green does not imply the goal works.**

---

## 8. Running many tasks at once

```sh
awo run --goal SHOP-G1 --dry-run          # the plan and every stopping condition
awo run --goal SHOP-G1 --until SHOP-T3    # explicit scope
awo run --goal SHOP-G1                    # everything ready, stop at the gate
awo run --goal SHOP-G1 --yolo             # don't stop on failure either
```

It stops when a task fails, when a dependency is awaiting your verdict, and **always**
on evidence flagged as needing a human — `--yolo` included, because continuing would
build the next task on a result nobody has judged.

`--yolo` relaxes failure-stopping. It does not relax the verdict. A machine grading its
own work is the one thing here that cannot be automated away.

---

## 9. Where the human belongs

The point of all the gates is that you don't read every diff. Reviewing everything at
human reading speed consumes the entire speedup — AI-authored PRs already wait ~4.6×
longer for a reviewer, and defects concentrate at **specification mismatches and
integration boundaries**, not inside isolated functions.

So spend attention here, in this order:

| where | cost | why |
|---|---|---|
| **The requirement and its DoD** | 10–20 min | shortest artefact, highest consequence, irreplaceable judgment |
| **The seams** — `dependsOn` and the interfaces | 10 min | no worker can see the seam it's on one side of |
| **What counts as evidence** | once per repo | `awo test-command` |
| **The gate verdict** | 10–15 min | judging a curated argument, not 2,000 lines of diff |
| **Irreversible actions** | always | migrations, deploys, deletions — the trigger is blast radius, not code quality |

Line-by-line reading belongs on a short list of surfaces — auth, money, migrations,
public API, anything deleting data — not on everything.

---

## 10. Customising the workspace

**A rule** (always-on policy). The `AGENTS.md` list is generated from `rules/`, so
there is nothing to register:

```sh
awo rule new deploy-via-cloud-build \
  --summary "deploys go through Cloud Build, never gcloud run deploy"
```

Then write the policy body in `rules/deploy-via-cloud-build.md`. A rule an agent
cannot check itself against is a suggestion — where you can, say how compliance is
verified: a command, a file that must exist, a log event.

| what | where | registration |
|---|---|---|
| a rule | `rules/<id>.md`, or `awo rule new` | none — generated |
| a skill | `skills/<id>.md` | none — generated |
| a role | `agents/<id>.md`, or `awo agent add <name>` | none — generated |
| workflow glue | `instructions/<name>.md` | referenced by name |
| project conventions | anywhere in `AGENTS.md` **outside** the generated markers | merged on upgrade |

Each file needs `id:` and `summary:` in its frontmatter; `summary` is the line that
appears in the generated list.

---

## 11. Model tiering

Every role is a **worker**. The orchestrator is the session you talk to, not an entry
in `agents/`. A worker's tier follows the *kind of work*, not its seniority:

```jsonc
// .workspace/manifest.json
"models": {
  "orchestrator": { "runtime": "codex", "model": "gpt-5.6-sol" },
  "tiers": {
    "high":     { "runtime": "codex", "model": "gpt-5.6-sol",   "effort": "high" },
    "standard": { "runtime": "codex", "model": "gpt-5.6-terra", "effort": "medium" },
    "low":      { "runtime": "codex", "model": "gpt-5.6-luna",  "effort": "medium",
                  "fallback": { "runtime": "codex", "model": "gpt-5.6-terra" } }
  }
}
```

Resolution order: a task's `tier:` → the agent's `tier:` → the role default →
`standard`. Only `medium` and `high` effort are selectable; `low` was removed after
low-effort implementation produced defects that a high-effort review had to catch.

The run index records tier, model, effort and attempts, so the question is answerable
rather than a matter of opinion:

```sh
awo log list --tier low --status failed
```

---

## 12. Watching what happens

```sh
awo context               # run this FIRST in any new session
awo log list --task SHOP-T2
awo log show <runId>
awo log tail
awo ui                    # local dashboard on 127.0.0.1
```

`awo context` is a derived digest — project, repos, goals, blocked and running tasks,
intake, recent runs, and a `NEXT` line. Cheaper and more accurate than an agent
scanning the tree.

A day of logs is two files:

```
logs/2026-07-28/runs.jsonl   every event + one row per run, append-only
logs/2026-07-28/runs.md      every run's record, one marked section each
logs/2026-07-28/workers/     raw worker stdout, when one was dispatched
```

Never hand-edit `runs.md`: the `<!-- awo:run … -->` markers are how a record is split
per run for `log show` and the hosted dashboard.

For workspaces that aren't on your machine, opt into the hosted dashboard:

```sh
echo 'MONGO_URI=mongodb+srv://…' > .workspace/credentials/mongo.env
awo publish              # manual
awo publish --watch      # debounced auto-sync
```

Local stays canonical; the push is a projection, never a mirror.

---

## 13. Upgrading

```sh
awo upgrade --dry-run
awo upgrade
```

Migrations run, scaffolding reconciles, and **your edits are never overwritten**.
Template changes are three-way merged around them using the pristine copy at
`.workspace/template-base/`. You only get asked when the same lines moved on both
sides:

```sh
awo resolve                          # show the diff
awo resolve AGENTS.md --theirs       # or --yours
```

---

## 14. Troubleshooting

**"cannot close as success on a test event awo did not run"** — you recorded a claim.
Re-record it as a measurement: `awo task event <id> test --run "<cmd>" --baseline`.
Or, if there is genuinely nothing to run, be honest: `--untested "<why>"`, which is
recorded in the log.

**"has evidence that needs a human, so it cannot go straight to done"** — the
measurement passed but is inconclusive (usually a test edited alongside its own code).
Close with `--gate` and look at it.

**"is proposed, not approved"** — intake is waiting on you: `awo req approve <id>`.

**"has unmet dependencies"** — a predecessor isn't `done`. If it's `in-review`, that's
the gate working; give the verdict.

**`recheck` says `pre-existing`** — that command fails at the branch point, so it
proves nothing about this task. Get the base green, or use a narrower command that
does pass on the base.

**Git Graph shows no repos** — open the generated `<KEY>.code-workspace`, not the
folder. VS Code ignores window-scoped settings from a folder's `.vscode/settings.json`
in a multi-root workspace.

**A worker edited a repo it shouldn't have** — check `git status` in *every* linked
repo, not only the declared targets. `awo doctor` does not catch this; the isolation
rail is keyed on `targets:`.

**`awo doctor` after anything unusual.** It reports version skew, broken links, bad
targets, abandoned runs, work claimed without evidence, unresolved `.new` conflicts,
rules `AGENTS.md` never mentions, and repos with no declared test command.

---

## 15. Before you use this on something that matters

Honest state of things, so you can decide rather than discover.

**Set up properly first**

1. `awo test-command <repo> "<cmd>"` for every repo. The evidence gate is only as
   good as the command, and an undeclared one gets invented per run.
2. Make sure that command **passes on your base branch**. A red base makes every
   measurement `pre-existing`, which verifies nothing. This is the single most common
   way the workflow degrades into theatre.
3. Set `pullRequests.mergePolicy` in the manifest. AWO never approves a PR; decide
   whether merging is `human-only`.
4. List **every** repo a task may touch in `--targets`, even where you expect no
   change. Isolation is keyed on that field, not on what the task text mentions.

**Known gaps**

- **Connectors are declarative only.** `.workspace/connectors.json` exists and rules
  can describe policy ("deploy via Cloud Build, never `gcloud run deploy`"), but
  nothing *enforces* it. A rule an agent chooses to ignore is documentation. Until
  awo invokes those tools itself, treat deployment policy as advisory.
- **`awo run` with real workers is lightly exercised.** The plan, scoping and stop
  conditions are tested; long autonomous chains with live models are not. Start with
  `--dry-run`, then `--until`, before letting it run a whole goal.
- **The hosted dashboard has no auth.** Whoever holds the connection string sees
  everything in that cluster. Fine for local use; decide before deploying it.
- **`publish --detail full` sends prose** — task bodies, run records, prompts. That
  describes your code and your instructions. It is opt-in for that reason.
- **Nothing verifies that an agent's tests are meaningful.** awo checks that the
  command ran and passed, and flags tests edited alongside their own code — but a
  vacuous assertion that passes still passes. Reviewing *new test files* is a good use
  of the ten minutes you saved.

**What is solid**

Isolation, the evidence gate, the intake gate, the lifecycle state machine, the audit
trail, and upgrades — each has tests, and most exist because something went wrong
first. `PROJECT_PLAN.md` §9 records 78 such findings with what broke and what it
taught; it is the most useful thing to read before trusting any of this.
