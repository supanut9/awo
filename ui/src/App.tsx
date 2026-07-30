import { useCallback, useEffect, useState } from "react";
import { api, type RunEvent, type Snapshot, type TaskStatus } from "./api";
import Board from "./components/Board";
import TaskDrawer from "./components/TaskDrawer";
import Timeline from "./components/Timeline";
import Markdown from "./components/Markdown";

type Tab = "board" | "requirements" | "runs" | "repos" | "analytics";

const TAB_COPY: Record<Tab, { label: string; eyebrow: string; title: string }> = {
  board: { label: "Workboard", eyebrow: "Live work", title: "Make the next move obvious." },
  requirements: { label: "Requirements", eyebrow: "Intake and scope", title: "Keep the intent visible before work starts." },
  runs: { label: "Run history", eyebrow: "Evidence", title: "Read what actually happened." },
  repos: { label: "Repositories", eyebrow: "Connected code", title: "Keep the working surface healthy." },
  analytics: { label: "Model signal", eyebrow: "Cost and quality", title: "Check whether the tiering policy earns its keep." },
};

const STATUS_TONE: Record<string, string> = {
  todo: "bg-stone-200 text-stone-700",
  queued: "bg-sky-100 text-sky-800",
  running: "bg-amber-100 text-amber-900",
  blocked: "bg-red-100 text-red-800",
  "in-review": "bg-violet-100 text-violet-800",
  done: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-stone-200 text-stone-500",
  present: "bg-emerald-100 text-emerald-800",
  dirty: "bg-amber-100 text-amber-900",
  missing: "bg-red-100 text-red-800",
};

function duration(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [tab, setTab] = useState<Tab>("board");
  const [groupByGoal, setGroupByGoal] = useState(true);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<{ id: string; events: RunEvent[]; markdown: string | null } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnap(await api.snapshot());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const src = new EventSource("/api/stream");
    src.onopen = () => setLive(true);
    src.onerror = () => setLive(false);
    src.addEventListener("changed", () => void refresh());
    return () => src.close();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const move = useCallback(
    async (taskId: string, status: TaskStatus) => {
      try {
        await api.setStatus(taskId, status);
        await refresh();
      } catch (e) {
        // §7.4 rejects invalid transitions; surface the reason rather than
        // silently snapping the card back.
        setToast((e as Error).message);
      }
    },
    [refresh]
  );

  const showRun = useCallback(async (runId: string) => {
    const [events, markdown] = await Promise.all([
      api.events(runId).catch(() => []),
      api.runDetail(runId).then((r) => r.markdown).catch(() => null),
    ]);
    setOpenRun({ id: runId, events, markdown });
  }, []);

  if (error && !snap) {
    return <div className="p-6 text-sm text-red-600 dark:text-red-400">{error}</div>;
  }
  if (!snap) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;

  const { project, stats, goals, repos, runs } = snap;
  // An already-running local server can briefly serve a pre-upgrade snapshot
  // while its static bundle has been rebuilt. Render an empty intake view until
  // the server is restarted or sends the new shape.
  const requirements = snap.requirements ?? [];
  const pct = stats.successRate === null ? "—" : `${Math.round(stats.successRate * 100)}%`;
  const intakeRequirements = requirements.filter((requirement) => requirement.goalId === null);
  const proposedRequirements = intakeRequirements.filter((requirement) => requirement.status === "proposed");
  const plannedRequirements = requirements.filter((requirement) => requirement.goalId !== null);
  const coveredCriteria = requirements.reduce((total, requirement) => total + requirement.criteria.covered, 0);
  const totalCriteria = requirements.reduce((total, requirement) => total + requirement.criteria.total, 0);

  const attention = goals.flatMap((goal) => goal.tasks).filter((task) =>
    task.status === "blocked" || task.status === "running" || task.status === "in-review"
  );
  const currentTab = TAB_COPY[tab];

  return (
    <div className="min-h-screen font-sans text-ink">
      <header className="border-b border-ink/10 bg-cloud/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-moss-deep font-display text-lg italic text-white">a</span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-display text-xl leading-none">{project.projectName}</h1>
                <span className="rounded-full bg-wash px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-moss-deep">{project.projectKey}</span>
              </div>
              <p className="mt-1 text-[11px] text-ink/55">AWO control room / v{project.libraryVersion}</p>
            </div>
          </div>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto rounded-full bg-wash/80 p-1 sm:order-none sm:ml-4 sm:w-auto" aria-label="Dashboard views">
            {(["board", "requirements", "runs", "repos", "analytics"] as Tab[]).map((item) => (
              <button
                key={item}
                onClick={() => setTab(item)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  tab === item ? "bg-moss-deep text-white shadow-sm" : "text-ink/60 hover:bg-cloud hover:text-ink"
                }`}
              >
                {TAB_COPY[item].label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-xs font-medium text-ink/60">
            <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(34,197,94,.13)]" : "bg-sun"}`} />
            {live ? "Synced live" : "Reconnecting"}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 pb-10 pt-7 sm:px-8">
        <section className="grid gap-6 rounded-[2rem] border border-ink/10 bg-cloud px-6 py-7 shadow-[0_20px_60px_rgba(38,48,42,.08)] lg:grid-cols-[1.15fr_.85fr] lg:px-9">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-moss">{currentTab.eyebrow}</p>
            <h2 className="mt-3 max-w-2xl font-display text-4xl leading-[.95] tracking-tight sm:text-5xl">{currentTab.title}</h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-ink/65">
              {tab === "requirements"
                ? `${intakeRequirements.length} requirement${intakeRequirements.length === 1 ? " is" : "s are"} still in intake. Requirements are read-only here so the human approval gate remains explicit.`
                : attention.length > 0
                ? `${attention.length} task${attention.length === 1 ? " needs" : "s need"} attention. Keep the board moving, then let evidence decide what is ready.`
                : "The board is clear. Start from the next planned task or review the evidence behind completed work."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
            {(tab === "requirements"
              ? [
                  ["In intake", intakeRequirements.length, "bg-sun/15 text-amber-950"],
                  ["Awaiting approval", proposedRequirements.length, "bg-red-100 text-red-900"],
                  ["Planned", plannedRequirements.length, "bg-emerald-100 text-emerald-950"],
                  ["Criteria covered", totalCriteria === 0 ? "-" : `${coveredCriteria}/${totalCriteria}`, "bg-moss text-white"],
                ]
              : [
                  ["In flight", stats.openRuns, "bg-sun/15 text-amber-950"],
                  ["Blocked", stats.byStatus.blocked ?? 0, "bg-red-100 text-red-900"],
                  ["Completed", stats.byStatus.done ?? 0, "bg-emerald-100 text-emerald-950"],
                  ["Evidence rate", pct, "bg-moss text-white"],
                ]
            ).map(([label, value, color]) => (
              <div key={String(label)} className={`rounded-2xl p-4 ${color}`}>
                <div className="font-display text-3xl leading-none">{value}</div>
                <div className="mt-2 text-[10px] font-bold uppercase tracking-[0.14em] opacity-70">{label}</div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="overflow-hidden rounded-[1.5rem] border border-ink/10 bg-cloud shadow-[0_12px_35px_rgba(38,48,42,.05)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink/10 px-5 py-4 sm:px-6">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-moss">{currentTab.eyebrow}</p>
                <h3 className="mt-1 font-display text-2xl">{currentTab.title}</h3>
              </div>
              {tab === "board" && (
                <label className="flex cursor-pointer items-center gap-2 rounded-full bg-wash px-3 py-2 text-xs font-semibold text-ink/70">
                  <input className="accent-moss" type="checkbox" checked={groupByGoal} onChange={(e) => setGroupByGoal(e.target.checked)} />
                  Group by goal
                </label>
              )}
            </div>
          {tab === "board" && (
            <>
              <div className="px-5 pt-4 text-xs text-ink/55 sm:px-6">Drag a card to change state. Invalid transitions stay protected by the workflow.</div>
              <Board
                goals={goals}
                selectedTask={selectedTask}
                onSelect={setSelectedTask}
                onMove={move}
                groupByGoal={groupByGoal}
              />
            </>
          )}

          {tab === "requirements" && (
            requirements.length === 0 ? (
              <EmptyState title="No requirements captured" copy="Start a product request with awo req new --title <title>. It will appear here before planning begins." />
            ) : (
              <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-6">
                {requirements.map((requirement) => {
                  const next = requirement.goalId
                    ? `Planned in ${requirement.goalId}`
                    : requirement.status === "draft"
                      ? `Refine: awo req refine ${requirement.id}`
                      : requirement.status === "proposed"
                        ? `Human gate: awo req approve ${requirement.id}`
                        : requirement.status === "rejected"
                          ? "Revise and propose again"
                          : `Plan: awo goal new --from ${requirement.id}`;
                  const statusTone = requirement.status === "approved"
                    ? "bg-emerald-100 text-emerald-800"
                    : requirement.status === "proposed"
                      ? "bg-amber-100 text-amber-900"
                      : requirement.status === "rejected"
                        ? "bg-red-100 text-red-800"
                        : "bg-stone-200 text-stone-700";
                  return (
                    <article key={requirement.id} className="rounded-2xl border border-ink/10 bg-paper p-4 shadow-[0_5px_16px_rgba(38,48,42,.04)]">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><div className="font-mono text-[11px] font-bold text-moss-deep">{requirement.id}</div><h4 className="mt-1 truncate font-display text-xl">{requirement.title}</h4></div>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${statusTone}`}>{requirement.status}</span>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-2 border-y border-ink/8 py-3 text-[11px] text-ink/60">
                        <div><span className="block text-[9px] font-bold uppercase tracking-[.12em] text-ink/40">Criteria</span>{requirement.criteria.covered}/{requirement.criteria.total} covered{requirement.criteria.exceptions > 0 ? `, ${requirement.criteria.exceptions} exception${requirement.criteria.exceptions === 1 ? "" : "s"}` : ""}</div>
                        <div><span className="block text-[9px] font-bold uppercase tracking-[.12em] text-ink/40">Location</span>{requirement.goalId ?? "Intake"}</div>
                      </div>
                      <p className="mt-3 text-[11px] leading-5 text-ink/55">{next}</p>
                    </article>
                  );
                })}
              </div>
            )
          )}

          {tab === "runs" && (
            <>
              {runs.length === 0 ? (
                <EmptyState title="No runs recorded" copy="Open a task run to start a traceable evidence trail." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-xs">
                    <thead className="bg-wash/55 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/55">
                      <tr>
                        <th className="px-5 py-3 text-left">Run</th>
                        <th className="px-4 py-3 text-left">Task</th>
                        <th className="px-4 py-3 text-left">Outcome</th>
                        <th className="px-4 py-3 text-left">Tier</th>
                        <th className="px-4 py-3 text-left">Duration</th>
                        <th className="px-5 py-3 text-left">Repos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr
                          key={r.runId}
                          onClick={() => void showRun(r.runId)}
                          className="cursor-pointer border-b border-ink/8 last:border-0 transition hover:bg-wash/45"
                        >
                          <td className="px-5 py-3 font-mono text-[11px] font-semibold">{r.runId}</td>
                          <td className="px-4 py-2 font-mono">{r.taskId ?? "—"}</td>
                          <td className="px-4 py-2"><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${r.status === "success" ? "bg-emerald-100 text-emerald-800" : r.status === "failed" ? "bg-red-100 text-red-800" : "bg-wash text-ink/60"}`}>{r.status}</span></td>
                          <td className="px-4 py-2 text-ink/60">
                            {r.tier ?? "—"}
                            {r.effort ? ` / ${r.effort}` : ""}
                            {r.attempts && r.attempts > 1 ? ` ×${r.attempts}` : ""}
                          </td>
                          <td className="px-4 py-2">{duration(r.durationSec)}</td>
                          <td className="px-5 py-2 text-ink/60">{r.reposChanged.join(", ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === "analytics" && (
            <>
              {stats.byTier.length === 0 ? (
                <EmptyState title="No completed runs" copy="Model signal appears after a run has closed." />
              ) : (
                <>
                  <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-xs">
                    <thead className="bg-wash/55 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/55">
                      <tr>
                        <th className="px-4 py-2 text-left">tier / effort</th>
                        <th className="px-4 py-2 text-right">runs</th>
                        <th className="px-4 py-2 text-right">success</th>
                        <th className="px-4 py-2 text-right">avg attempts</th>
                        <th className="px-4 py-2 text-right">avg duration</th>
                        <th className="px-4 py-2 text-right">total time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byTier.map((t) => (
                        <tr
                          key={t.key}
                          className="border-b border-ink/8 last:border-0"
                        >
                          <td className="px-5 py-3 font-mono font-semibold">{t.key}</td>
                          <td className="px-4 py-2 text-right">{t.runs}</td>
                          <td
                            className={`px-4 py-2 text-right ${
                              t.successRate < 0.7 ? "text-coral" : "text-moss"
                            }`}
                          >
                            {Math.round(t.successRate * 100)}%
                          </td>
                          <td
                            className={`px-4 py-2 text-right ${
                              t.avgAttempts > 1.5 ? "text-coral" : ""
                            }`}
                          >
                            {t.avgAttempts.toFixed(1)}
                          </td>
                          <td className="px-4 py-2 text-right">{duration(t.avgDurationSec)}</td>
                          <td className="px-5 py-2 text-right">{duration(t.totalDurationSec)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                  <p className="border-t border-ink/10 bg-wash/30 px-5 py-4 text-[11px] leading-relaxed text-ink/60">
                    A lower tier with <strong>more attempts</strong> than a higher one is the
                    cheap model giving back what it saved — judge it here rather than
                    assuming. Attempts count reruns of the same task, so environmental
                    failures inflate them too: read a high number as "look at these runs",
                    not as proof about the model.
                    {stats.untestedSuccesses > 0 && (
                      <>
                        {" "}
                        <strong className="text-coral">
                          {stats.untestedSuccesses} success{stats.untestedSuccesses === 1 ? "" : "es"} had no
                          test evidence
                        </strong>{" "}
                        — each one is an exemption someone chose.
                      </>
                    )}
                  </p>
                </>
              )}
            </>
          )}

          {tab === "repos" && (
            <>
              <table className="w-full text-xs">
                <tbody>
                  {repos.map((r) => (
                    <tr key={r.name} className="border-b border-ink/8 last:border-0">
                      <td className="px-5 py-4 font-mono text-sm font-semibold">{r.name}</td>
                      <td className="px-4 py-4 text-ink/60">{r.type} repository</td>
                      <td className="px-5 py-4 text-right"><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${STATUS_TONE[r.status] ?? "bg-wash text-ink/60"}`}>{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          </section>

          <aside className="self-start rounded-[1.5rem] border border-ink/10 bg-moss-deep p-5 text-white shadow-[0_12px_35px_rgba(23,56,47,.16)] lg:sticky lg:top-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/55">{tab === "requirements" ? "Intake rail" : "Action rail"}</p>
            <h3 className="mt-2 font-display text-3xl leading-none">{tab === "requirements" ? "Next gates" : "Attention"}</h3>
            <p className="mt-3 text-xs leading-5 text-white/65">{tab === "requirements" ? "Requirements that need a person or planning decision." : "Work that could change the project state now."}</p>
            <div className="mt-5 space-y-2">
              {tab === "requirements" ? (
                intakeRequirements.length === 0 ? <div className="rounded-2xl border border-white/15 bg-white/7 p-4 text-sm text-white/70">No intake items waiting. Requirements are either planned or not yet captured.</div> : intakeRequirements.slice(0, 5).map((requirement) => (
                  <div key={requirement.id} className="rounded-2xl border border-white/12 bg-white/7 p-3"><div className="flex items-center justify-between gap-2"><span className="font-mono text-[11px] font-bold">{requirement.id}</span><span className="rounded-full bg-white/12 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide">{requirement.status}</span></div><div className="mt-1.5 text-xs leading-4 text-white/82">{requirement.title}</div></div>
                ))
              ) : attention.length === 0 ? (
                <div className="rounded-2xl border border-white/15 bg-white/7 p-4 text-sm text-white/70">Nothing urgent. Pick the next planned task from the board.</div>
              ) : attention.slice(0, 5).map((task) => (
                <button key={task.id} onClick={() => setSelectedTask(task.id)} className="w-full rounded-2xl border border-white/12 bg-white/7 p-3 text-left transition hover:bg-white/13">
                  <div className="flex items-center justify-between gap-2"><span className="font-mono text-[11px] font-bold">{task.id}</span><span className="rounded-full bg-white/12 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide">{task.status}</span></div>
                  <div className="mt-1.5 text-xs leading-4 text-white/82">{task.name}</div>
                  {task.blockedReason && <div className="mt-2 text-[11px] leading-4 text-[#ffd2c7]">{task.blockedReason}</div>}
                </button>
              ))}
            </div>
            <div className="mt-6 border-t border-white/12 pt-4 text-[11px] text-white/55">
              <div className="flex justify-between"><span>{tab === "requirements" ? "All requirements" : "Goals"}</span><strong className="font-mono text-white">{tab === "requirements" ? requirements.length : goals.length}</strong></div>
              <div className="mt-2 flex justify-between"><span>{tab === "requirements" ? "Awaiting approval" : "Recorded runs"}</span><strong className="font-mono text-white">{tab === "requirements" ? proposedRequirements.length : stats.totalRuns}</strong></div>
              <div className="mt-2 flex justify-between"><span>{tab === "requirements" ? "Planned" : "Average run"}</span><strong className="font-mono text-white">{tab === "requirements" ? plannedRequirements.length : duration(stats.avgDurationSec)}</strong></div>
            </div>
          </aside>
        </div>
      </main>

      {selectedTask && (
        <TaskDrawer taskId={selectedTask} onClose={() => setSelectedTask(null)} onMove={move} />
      )}

      {openRun && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-moss-deep/45 p-4 sm:p-6"
          onClick={() => setOpenRun(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-[1.5rem] border border-ink/10 bg-cloud p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 font-mono text-xs font-semibold text-moss">{openRun.id}</div>
            <Timeline events={openRun.events} />
            {openRun.markdown && (
              <div className="mt-5 border-t border-ink/10 pt-4">
                <Markdown source={openRun.markdown} />
              </div>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-40 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full border border-coral/30 bg-cloud px-4 py-2 text-xs text-coral shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="px-6 py-16 text-center"><div className="font-display text-3xl">{title}</div><p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-ink/60">{copy}</p></div>;
}
