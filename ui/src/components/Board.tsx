import { useState } from "react";
import { TASK_STATUSES, type GoalView, type TaskStatus, type TaskView } from "../api";

const ACCENT: Record<TaskStatus, string> = {
  todo: "border-l-neutral-400",
  queued: "border-l-sky-400",
  running: "border-l-indigo-500",
  blocked: "border-l-red-500",
  "in-review": "border-l-amber-500",
  done: "border-l-emerald-500",
  cancelled: "border-l-neutral-300 opacity-55",
};

const OUTCOME: Record<string, string> = {
  success: "text-emerald-600 dark:text-emerald-400 border-emerald-600/40",
  failed: "text-red-600 dark:text-red-400 border-red-600/40",
  skipped: "text-neutral-500 border-neutral-400/40",
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
      className={`mb-2 cursor-pointer rounded-md border border-l-3 bg-white p-2.5 text-left transition
        hover:border-indigo-400 dark:bg-neutral-900 ${ACCENT[task.status]}
        ${selected ? "border-indigo-500 ring-2 ring-indigo-500/25" : "border-neutral-200 dark:border-neutral-800"}`}
    >
      <div className="font-mono text-xs font-semibold">{task.id}</div>
      <div className="mt-0.5 text-xs leading-snug">{task.name}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
        {task.agent && <span>{task.agent}</span>}
        {task.targets.length > 0 && <span className="truncate">{task.targets.join(", ")}</span>}
        {task.lastRunOutcome && (
          <span className={`rounded-full border px-1.5 ${OUTCOME[task.lastRunOutcome] ?? ""}`}>
            {task.lastRunOutcome}
          </span>
        )}
        {task.attempts > 1 && <span>×{task.attempts}</span>}
      </div>
      {task.blockedReason && (
        <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">{task.blockedReason}</div>
      )}
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
      <div className="p-8 text-center text-sm text-neutral-500">
        No tasks yet. Author one under <code className="font-mono">goals/&lt;goal&gt;/tasks/</code>.
      </div>
    );
  }

  return (
    <div className="space-y-5 overflow-x-auto p-3.5">
      {swimlanes.map((lane) => (
        <div key={lane.id}>
          {groupByGoal && (
            <div className="mb-2 flex items-baseline gap-2">
              <span className="font-mono text-xs font-semibold">{lane.id}</span>
              <span className="text-xs text-neutral-500">{lane.title}</span>
              <span className="rounded border border-neutral-300 px-1.5 text-[10px] text-neutral-500 dark:border-neutral-700">
                {lane.status}
              </span>
            </div>
          )}
          <div className="grid min-w-[1050px] grid-cols-7 gap-2.5">
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
                  className={`min-h-24 rounded-md p-1 transition ${
                    over === `${lane.id}:${status}`
                      ? "bg-indigo-500/10 outline-2 outline-dashed outline-indigo-400"
                      : ""
                  }`}
                >
                  <div className="mb-1.5 flex justify-between px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
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
