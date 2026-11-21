import { type ChildProcess } from "child_process";

/**
 * Supervise a child spawned with `detached: true`, so a timeout reaches
 * everything it started.
 *
 * `child.kill()` signals only the direct child. A measured command is usually a
 * shell running a runner running workers, and a dispatched worker spawns its own
 * tools; killing just the leader left the rest running and holding the output
 * pipe, so `close` never fired and the "timed out" run hung with it. A detached
 * child leads its own process group, and `process.kill(-pid)` signals the whole
 * group.
 *
 * The price of detaching is that the terminal's Ctrl-C no longer reaches the
 * group (it is not the foreground group any more), so SIGINT/SIGTERM to awo are
 * forwarded while the child runs — otherwise interrupting awo would orphan a
 * 30-minute test suite.
 */
export interface GroupExit {
  code: number | null;
  timedOut: boolean;
  error?: Error;
}

const KILL_GRACE_MS = 5000;
/** How long to wait for the pipes to drain after the leader has exited. */
const DRAIN_GRACE_MS = 2000;

export const detachable = process.platform !== "win32";

export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (detachable) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The group is already gone; nothing left to signal.
  }
}

export function superviseGroup(child: ChildProcess, timeoutMs: number): Promise<GroupExit> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let escalate: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;

    const forward = (signal: NodeJS.Signals): void => {
      killGroup(child, signal);
      cleanup();
      // Re-raise with our listener gone, so awo still dies the way it would have.
      process.kill(process.pid, signal);
    };
    const onInt = (): void => forward("SIGINT");
    const onTerm = (): void => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      escalate = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      if (drain) clearTimeout(drain);
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    }
    const finish = (result: GroupExit): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    child.on("error", (error) => finish({ code: 127, timedOut: false, error }));
    child.on("exit", (code) => {
      // `close` waits for every holder of the pipe. A straggler left in the group
      // (a server started with `&`, a runner's worker) would keep it open forever,
      // so once the leader is gone the group gets a short grace and is then killed.
      drain = setTimeout(() => {
        killGroup(child, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code, timedOut });
      }, DRAIN_GRACE_MS);
    });
    child.on("close", (code) => finish({ code, timedOut }));
  });
}
