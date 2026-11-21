import { execFileSync } from "node:child_process";
import { actorLabel, detectAgentEnvironment, type AgentEnvironment } from "./agent-env.js";
import { delegationAllowed, type Manifest } from "./manifest.js";

/**
 * Who is answerable for a decision, and how it reached awo.
 *
 * Measured on the real workspaces: 22 of 22 requirement approvals and 26 of 26 goal
 * verdicts were typed by an agent, and most were logged as "human" — the literal
 * default of `--who`. A gate whose audit record flatters the process is worse than
 * no gate, because it is believed. So the record now says what happened: a person
 * typed it, or an agent typed it on a named person's instruction.
 */
export interface Delegation {
  by: string;
  instruction: string | null;
  via: string;
}

export interface DecisionActor {
  /** The person answerable for the decision (or the acting agent, when none is named). */
  by: string;
  /** `human` when a person typed it; otherwise the agent runtime that did. */
  via: string;
  delegation: Delegation | null;
}

export interface DecisionOptions {
  who?: string;
  delegatedBy?: string;
  instruction?: string;
}

/**
 * Values that name a role or a placeholder rather than a person. `--who "<human>"`
 * is copied verbatim from the skill templates often enough to be worth refusing.
 */
const NOT_A_PERSON = new Set([
  "human", "user", "the user", "me", "myself", "unknown", "someone", "anyone",
  "agent", "ai", "assistant", "claude", "codex", "gemini",
]);

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertNamesAPerson(value: string, flag: string): void {
  if (NOT_A_PERSON.has(value.toLowerCase()) || /^<.*>$/.test(value)) {
    throw new Error(
      `${flag} "${value}" names a role or a placeholder, not a person. Name who is answerable\n` +
        `  for the decision, e.g. ${flag} "<their name or handle>" (without the angle brackets).`
    );
  }
}

/** The local git identity, which is a better default than a word nobody chose. */
export function gitUserName(cwd: string): string | null {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Who made an ordinary intake decision (reject, suspend, cancel, resume).
 *
 * Never the literal "human": an explicit `--who`/`--delegated-by` wins, then the
 * acting agent's own label, then the local git identity, then "unknown".
 */
export function resolveDecider(
  root: string,
  options: DecisionOptions,
  env: AgentEnvironment = detectAgentEnvironment()
): DecisionActor {
  const via = actorLabel(env);
  const delegatedBy = clean(options.delegatedBy);
  const who = clean(options.who);
  if (delegatedBy) {
    assertNamesAPerson(delegatedBy, "--delegated-by");
    return {
      by: delegatedBy,
      via,
      delegation: { by: delegatedBy, instruction: clean(options.instruction), via },
    };
  }
  if (who) return { by: who, via, delegation: null };
  if (env.isAgent) return { by: via, via, delegation: null };
  return { by: gitUserName(root) ?? "unknown", via, delegation: null };
}

/**
 * The human gates — `req approve` and `goal verdict`.
 *
 * Detection is environmental and therefore advisory: an agent can lie, and a
 * human typing through an agent's shell passthrough looks like an agent. Both are
 * handled by making the honest path the easy one — `AWO_HUMAN=1` for the person,
 * `--delegated-by` + `--instruction` for the agent acting on their word — and by
 * recording which of the two it was, rather than by pretending to authenticate.
 */
export function resolveHumanGate(input: {
  /** The command as the user would retype it, for messages. */
  command: string;
  manifest: Manifest;
  root: string;
  options: DecisionOptions;
  /** When set, a human must name themselves with --who; this is the refusal. */
  requireWho?: string;
  env?: AgentEnvironment;
}): DecisionActor {
  const env = input.env ?? detectAgentEnvironment();
  const via = actorLabel(env);
  const who = clean(input.options.who);
  const delegatedBy = clean(input.options.delegatedBy);
  const instruction = clean(input.options.instruction);
  const detected = env.source ? ` (${env.source} is set)` : "";

  if (instruction && !delegatedBy) {
    throw new Error(
      `--instruction quotes the person who delegated the decision; pass it together with\n` +
        `  --delegated-by "<who>".`
    );
  }

  if (!delegationAllowed(input.manifest)) {
    if (env.isAgent) {
      throw new Error(
        `\`${input.command}\` is a human decision, and this workspace does not allow delegating it\n` +
          `  (governance.allowDelegation: false in .workspace/manifest.json).\n` +
          `  This shell looks like an agent runtime${detected}.\n` +
          `  If you are the human: run it in your own terminal, or prefix it with AWO_HUMAN=1\n` +
          `  when typing through an agent's shell passthrough.\n` +
          `  If you are an agent: stop and ask the human to run it — --delegated-by is not accepted here.`
      );
    }
    if (delegatedBy) {
      throw new Error(
        `Delegation is disabled in this workspace (governance.allowDelegation: false).\n` +
          `  The deciding person runs it themselves:  ${input.command} --who "<their name>"`
      );
    }
  }

  if (env.isAgent && !delegatedBy) {
    throw new Error(
      `\`${input.command}\` is a human decision, and this shell looks like an agent runtime${detected}.\n` +
        `  If you are the human: run it in your own terminal, or prefix it with AWO_HUMAN=1.\n` +
        `  If you are acting on a human's instruction, name them and quote it:\n` +
        `    ${input.command} --delegated-by "<who>" --instruction "<their words, verbatim>"\n` +
        `  It is then recorded as delegated by that person, not as their own keystroke.`
    );
  }

  if (delegatedBy) {
    assertNamesAPerson(delegatedBy, "--delegated-by");
    if (who && who !== delegatedBy) {
      throw new Error(
        `--who "${who}" and --delegated-by "${delegatedBy}" name different people.\n` +
          `  The decision belongs to the person who delegated it; pass only --delegated-by.`
      );
    }
    return { by: delegatedBy, via, delegation: { by: delegatedBy, instruction, via } };
  }

  if (who) {
    assertNamesAPerson(who, "--who");
    return { by: who, via: "human", delegation: null };
  }
  if (input.requireWho) throw new Error(input.requireWho);
  return { by: gitUserName(input.root) ?? "unknown", via: "human", delegation: null };
}

/** One line for logs and CLI output. */
export function describeActor(actor: DecisionActor): string {
  if (actor.delegation) {
    const quote = actor.delegation.instruction ? `: "${actor.delegation.instruction}"` : "";
    return `${actor.by} (delegated — recorded by ${actor.via} on their instruction${quote})`;
  }
  if (actor.via === "human") return `${actor.by} (human)`;
  return actor.by === actor.via ? `${actor.by} (agent)` : `${actor.by} (via ${actor.via})`;
}
