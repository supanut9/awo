import { useCallback, useEffect, useState } from "react";
import { api, type RunEvent, type Snapshot, type TaskStatus } from "./api";
import Board from "./components/Board";
import TaskDrawer from "./components/TaskDrawer";
import Timeline from "./components/Timeline";
import Markdown from "./components/Markdown";

type Tab = "board" | "runs" | "repos";

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
  const pct = stats.successRate === null ? "—" : `${Math.round(stats.successRate * 100)}%`;

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-neutral-200 bg-white px-5 py-3 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="rounded bg-indigo-600 px-1.5 py-1 font-mono text-[11px] font-semibold text-white">
          {project.projectKey}
        </span>
        <h1 className="text-base font-semibold">{project.projectName}</h1>
        <span className="text-xs text-neutral-500">awo {project.libraryVersion}</span>

        <nav className="ml-4 flex gap-1">
          {(["board", "runs", "repos"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                tab === t
                  ? "bg-neutral-200 dark:bg-neutral-800"
                  : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 text-xs text-neutral-500">
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-neutral-400"}`} />
          {live ? "live" : "reconnecting…"}
        </div>
      </header>

      <div className="flex flex-wrap border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        {[
          ["Tasks", stats.totalTasks],
          ["Goals", goals.length],
          ["Running", stats.openRuns],
          ["Blocked", stats.byStatus.blocked ?? 0],
          ["Done", stats.byStatus.done ?? 0],
          ["Runs", stats.totalRuns],
          ["Success", pct],
          ["Avg run", stats.avgDurationSec === null ? "—" : `${stats.avgDurationSec}s`],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className="min-w-28 border-r border-neutral-200 px-4 py-3 last:border-r-0 dark:border-neutral-800"
          >
            <div className="text-xl font-semibold tracking-tight">{value}</div>
            <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
          </div>
        ))}
      </div>

      <main className="p-5">
        <section className="rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          {tab === "board" && (
            <>
              <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Board — drag a card to change status
                </h2>
                <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                  <input
                    type="checkbox"
                    checked={groupByGoal}
                    onChange={(e) => setGroupByGoal(e.target.checked)}
                  />
                  group by goal
                </label>
              </div>
              <Board
                goals={goals}
                selectedTask={selectedTask}
                onSelect={setSelectedTask}
                onMove={move}
                groupByGoal={groupByGoal}
              />
            </>
          )}

          {tab === "runs" && (
            <>
              <h2 className="border-b border-neutral-200 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                Runs
              </h2>
              {runs.length === 0 ? (
                <div className="p-8 text-center text-sm text-neutral-500">No runs recorded yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[10px] uppercase tracking-wide text-neutral-500">
                      <tr className="border-b border-neutral-200 dark:border-neutral-800">
                        <th className="px-4 py-2 text-left">Run</th>
                        <th className="px-4 py-2 text-left">Task</th>
                        <th className="px-4 py-2 text-left">Outcome</th>
                        <th className="px-4 py-2 text-left">Duration</th>
                        <th className="px-4 py-2 text-left">Repos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr
                          key={r.runId}
                          onClick={() => void showRun(r.runId)}
                          className="cursor-pointer border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40"
                        >
                          <td className="px-4 py-2 font-mono">{r.runId}</td>
                          <td className="px-4 py-2 font-mono">{r.taskId ?? "—"}</td>
                          <td className="px-4 py-2">{r.status}</td>
                          <td className="px-4 py-2">{r.durationSec === null ? "—" : `${r.durationSec}s`}</td>
                          <td className="px-4 py-2 text-neutral-500">{r.reposChanged.join(", ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === "repos" && (
            <>
              <h2 className="border-b border-neutral-200 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                Linked repos
              </h2>
              <table className="w-full text-xs">
                <tbody>
                  {repos.map((r) => (
                    <tr key={r.name} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60">
                      <td className="px-4 py-2 font-mono">{r.name}</td>
                      <td className="px-4 py-2 text-neutral-500">{r.type}</td>
                      <td
                        className={`px-4 py-2 ${
                          r.status === "missing"
                            ? "text-red-600 dark:text-red-400"
                            : r.status === "dirty"
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {r.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </main>

      {selectedTask && (
        <TaskDrawer taskId={selectedTask} onClose={() => setSelectedTask(null)} onMove={move} />
      )}

      {openRun && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setOpenRun(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 font-mono text-xs font-semibold">{openRun.id}</div>
            <Timeline events={openRun.events} />
            {openRun.markdown && (
              <div className="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
                <Markdown source={openRun.markdown} />
              </div>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-md border border-red-500/40 bg-white px-4 py-2 text-xs text-red-600 shadow-lg dark:bg-neutral-900 dark:text-red-400">
          {toast}
        </div>
      )}
    </div>
  );
}
