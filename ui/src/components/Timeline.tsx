import type { RunEvent } from "../api";

const KIND_COLOR: Record<string, string> = {
  "run.start": "text-indigo-600 dark:text-indigo-400",
  "run.end": "text-emerald-600 dark:text-emerald-400",
  test: "text-sky-600 dark:text-sky-400",
  "repo.diff": "text-amber-600 dark:text-amber-400",
  note: "text-neutral-500",
};

export default function Timeline({ events }: { events: RunEvent[] }) {
  if (events.length === 0) {
    return <div className="p-4 text-sm text-neutral-500">No events recorded for this run.</div>;
  }
  return (
    <ul className="divide-y divide-dashed divide-neutral-200 dark:divide-neutral-800">
      {events.map((e, i) => {
        const detail = Object.entries(e)
          .filter(([k]) => k !== "t" && k !== "kind")
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join("  ");
        return (
          <li key={i} className="flex gap-3 py-1.5 text-xs">
            <span className="shrink-0 font-mono text-neutral-500">{e.t.slice(11, 19)}</span>
            <span className={`w-24 shrink-0 font-semibold ${KIND_COLOR[e.kind] ?? ""}`}>{e.kind}</span>
            <span className="break-all text-neutral-500">{detail}</span>
          </li>
        );
      })}
    </ul>
  );
}
