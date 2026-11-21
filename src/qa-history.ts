import type { GoalQaState, GoalState } from "./state.js";

/** A QA record that was replaced or invalidated, and why. */
export type RetiredQaState = GoalQaState & {
  retiredReason?: string;
  retiredAt?: string;
};

/**
 * Move the current QA record into `qaHistory` before anything replaces or
 * deletes it.
 *
 * Measured on atlas-shop: 13 GAP verdicts are in the day logs and none survive in
 * state, because every new brief, new task, status change and evidence edit simply
 * deleted or overwrote `state.qa`. The log keeps prose; state is what readers and
 * the dashboard query — so a verdict that is no longer current is retired, never
 * dropped. No-op when there is no current record.
 */
export function retireQa(state: GoalState, reason: string): void {
  if (!state.qa) return;
  const retired: RetiredQaState = {
    ...state.qa,
    retiredReason: reason,
    retiredAt: new Date().toISOString(),
  };
  (state.qaHistory ??= []).push(retired);
  delete state.qa;
}
