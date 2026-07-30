import type { RunEvent } from "../api";

const KIND_COLOR: Record<string, string> = {
  "run.start": "text-moss",
  "run.end": "text-emerald-700",
  test: "text-sky-700",
  "repo.diff": "text-sun",
  note: "text-ink/55",
};

export default function Timeline({ events }: { events: RunEvent[] }) {
  if (events.length === 0) {
    return <div className="p-4 text-sm text-ink/55">No events recorded for this run.</div>;
  }
  return (
    <ul className="divide-y divide-dashed divide-ink/12">
      {events.map((e, i) => {
        const detail = Object.entries(e)
          .filter(([k]) => k !== "t" && k !== "kind")
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join("  ");
        return (
          <li key={i} className="flex gap-3 py-2 text-xs">
            <span className="shrink-0 font-mono text-ink/50">{e.t.slice(11, 19)}</span>
            <span className={`w-24 shrink-0 font-semibold ${KIND_COLOR[e.kind] ?? ""}`}>{e.kind}</span>
            <span className="break-all text-ink/60">{detail}</span>
          </li>
        );
      })}
    </ul>
  );
}
