import { useEffect, useState } from "react";
import { api, TASK_STATUSES, type RunEvent, type TaskDetail, type TaskStatus } from "../api";
import Markdown from "./Markdown";
import Timeline from "./Timeline";

interface Props {
  taskId: string;
  onClose: () => void;
  onMove: (taskId: string, status: TaskStatus) => void;
}

/** The task's definition, its state, and its latest run — the drill-down the board lacks. */
export default function TaskDrawer({ taskId, onClose, onMove }: Props) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [runLog, setRunLog] = useState<string | null>(null);
  const [tab, setTab] = useState<"definition" | "events" | "log">("definition");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .task(taskId)
      .then(async (t) => {
        if (!live) return;
        setTask(t);
        if (t.lastRunId) {
          const [ev, log] = await Promise.all([
            api.events(t.lastRunId).catch(() => []),
            api.runDetail(t.lastRunId).then((r) => r.markdown).catch(() => null),
          ]);
          if (!live) return;
          setEvents(ev);
          setRunLog(log);
        } else {
          setEvents([]);
          setRunLog(null);
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [taskId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs = [
    ["definition", "Definition"],
    ["events", `Events${events.length ? ` (${events.length})` : ""}`],
    ["log", "Run log"],
  ] as const;

  return (
    <aside className="fixed inset-y-0 right-0 z-20 flex w-full max-w-xl flex-col border-l border-ink/10 bg-cloud shadow-2xl">
      <header className="flex items-start gap-3 border-b border-ink/10 p-5">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-bold text-moss-deep">{taskId}</div>
          <div className="mt-1 truncate font-display text-xl">{task?.name ?? "…"}</div>
        </div>
        <button
          onClick={onClose}
          className="rounded-full border border-ink/15 px-3 py-1 text-xs font-semibold text-ink/60 hover:border-moss hover:text-moss"
        >
          Esc
        </button>
      </header>

      {error && <div className="p-5 text-sm text-coral">{error}</div>}

      {task && (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-ink/10 p-5 text-xs">
            <Field label="Status" value={task.status} />
            <Field label="Goal" value={task.goalId} mono />
            <Field label="Agent" value={task.agent ?? "unassigned"} />
            <Field label="Attempts" value={String(task.attempts)} />
            <Field label="Targets" value={task.targets.join(", ") || "none"} />
            <Field label="Depends on" value={task.dependsOn.join(", ") || "nothing"} />
            {task.lastRunId && <Field label="Last run" value={task.lastRunId} mono span />}
            {task.blockedReason && <Field label="Blocked" value={task.blockedReason} span danger />}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 border-b border-ink/10 px-5 py-3">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink/50">Move to</span>
            {TASK_STATUSES.filter((s) => s !== task.status).map((s) => (
              <button
                key={s}
                onClick={() => onMove(task.id, s)}
                className="rounded-full border border-ink/15 px-2.5 py-1 text-[11px] font-semibold text-ink/65 hover:border-moss hover:text-moss"
              >
                {s}
              </button>
            ))}
          </div>

          <nav className="flex gap-1 border-b border-ink/10 px-4 pt-3">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded-t px-3 py-1.5 text-xs font-medium ${
                  tab === id
                    ? "border-b-2 border-moss text-moss"
                    : "text-ink/50 hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex-1 overflow-y-auto p-5">
            {tab === "definition" && (
              <>
                <Markdown source={task.body || "_This task file has no body._"} />
                <div className="mt-4 font-mono text-[11px] text-neutral-500">{task.file}</div>
              </>
            )}
            {tab === "events" && <Timeline events={events} />}
            {tab === "log" &&
              (runLog ? (
                <Markdown source={runLog} />
              ) : (
                <div className="text-sm text-ink/55">
                  No run log yet — one is written when a run completes.
                </div>
              ))}
          </div>
        </>
      )}
    </aside>
  );
}

function Field({
  label,
  value,
  mono,
  span,
  danger,
}: {
  label: string;
  value: string;
  mono?: boolean;
  span?: boolean;
  danger?: boolean;
}) {
  return (
    <div className={span ? "col-span-2" : ""}>
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink/45">{label}</div>
      <div
        className={`${mono ? "font-mono text-[11px]" : "text-xs"} ${
          danger ? "text-coral" : ""
        } break-words`}
      >
        {value}
      </div>
    </div>
  );
}
