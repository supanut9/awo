import { useState } from "react";
import { TASK_STATUSES, type GoalView, type TaskStatus, type TaskView } from "../api";

const ACCENT: Record<TaskStatus, string> = {
  todo: "border-l-stone-400",
  queued: "border-l-sky-400",
  running: "border-l-sun",
  blocked: "border-l-coral",
  "in-review": "border-l-violet-500",
  done: "border-l-moss",
  cancelled: "border-l-stone-300 opacity-55",
};

const OUTCOME: Record<string, string> = {
  success: "border-emerald-300 bg-emerald-50 text-emerald-800",
  failed: "border-red-300 bg-red-50 text-red-800",
  skipped: "border-stone-300 bg-stone-100 text-stone-600",
};

interface Props {
  goals: GoalView[];
  selectedTask: string | null;
  onSelect: (taskId: string) => void;
  onMove: (taskId: string, status: TaskStatus) => void;
  groupByGoal: boolean;
}

function Card({
  task,
  selected,
  onSelect,
}: {
  task: TaskView;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
      onClick={onSelect}
      className={`mb-2 cursor-pointer rounded-xl border border-l-4 bg-cloud p-3 text-left shadow-[0_4px_12px_rgba(38,48,42,.05)] transition
        hover:-translate-y-0.5 hover:border-moss/45 hover:shadow-[0_10px_20px_rgba(38,48,42,.09)] ${ACCENT[task.status]}
        ${selected ? "border-moss ring-2 ring-moss/15" : "border-ink/10"}`}
    >
      <div className="font-mono text-[11px] font-bold text-moss-deep">{task.id}</div>
      <div className="mt-1 text-xs font-semibold leading-snug text-ink">{task.name}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-ink/55">
        {task.agent && <span className="rounded bg-wash px-1.5 py-0.5">{task.agent}</span>}
        {task.targets.length > 0 && <span className="truncate font-mono">{task.targets.join(", ")}</span>}
        {task.lastRunOutcome && (
          <span className={`rounded-full border px-1.5 py-0.5 font-semibold ${OUTCOME[task.lastRunOutcome] ?? ""}`}>
            {task.lastRunOutcome}
          </span>
        )}
        {task.attempts > 1 && <span>×{task.attempts}</span>}
      </div>
      {task.blockedReason && <div className="mt-2 border-t border-coral/15 pt-2 text-[11px] leading-4 text-coral">{task.blockedReason}</div>}
    </div>
  );
}

export default function Board({ goals, selectedTask, onSelect, onMove, groupByGoal }: Props) {
  const [over, setOver] = useState<string | null>(null);
  const swimlanes = groupByGoal
    ? goals
    : [{ id: "__all", title: "", status: "", tasks: goals.flatMap((g) => g.tasks) }];

  if (goals.every((g) => g.tasks.length === 0)) {
    return (
      <div className="p-10 text-center text-sm text-ink/55">
        No tasks yet. Author one under <code className="font-mono">goals/&lt;goal&gt;/tasks/</code>.
      </div>
    );
  }

  return (
    <div className="space-y-6 overflow-x-auto px-4 pb-5 pt-4 sm:px-6">
      {swimlanes.map((lane) => (
        <div key={lane.id}>
          {groupByGoal && (
            <div className="mb-3 flex items-baseline gap-2">
              <span className="font-mono text-xs font-bold text-moss-deep">{lane.id}</span>
              <span className="text-xs text-ink/60">{lane.title}</span>
              <span className="rounded-full bg-wash px-2 py-0.5 text-[10px] font-semibold text-ink/60">
                {lane.status}
              </span>
            </div>
          )}
          <div className="grid min-w-[1050px] grid-cols-7 gap-3">
            {TASK_STATUSES.map((status) => {
              const inCol = lane.tasks.filter((t) => t.status === status);
              return (
                <div
                  key={status}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(`${lane.id}:${status}`);
                  }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(null);
                    const id = e.dataTransfer.getData("text/plain");
                    if (id) onMove(id, status);
                  }}
                  className={`min-h-28 rounded-2xl bg-wash/45 p-2 transition ${
                    over === `${lane.id}:${status}`
                      ? "bg-sun/20 outline-2 outline-dashed outline-sun"
                      : ""
                  }`}
                >
                  <div className="mb-2 flex justify-between px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-ink/50">
                    <span>{status}</span>
                    <span>{inCol.length || ""}</span>
                  </div>
                  {inCol.map((task) => (
                    <Card
                      key={task.id}
                      task={task}
                      selected={task.id === selectedTask}
                      onSelect={() => onSelect(task.id)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
