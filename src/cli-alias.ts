import { Option, type Command } from "commander";

/**
 * Accept the spelling an agent reaches for, without advertising a second name.
 *
 * Mined from 4,216 real invocations: agents guess `--msg`, `--note`, `--title`,
 * `--why` far more often than they read `--help`, and commander's edit-distance
 * suggestion cannot map `--msg` to `--message`. A hidden alias costs nothing in
 * the help text and removes a whole retry loop.
 *
 * `flags` is the alias as commander syntax (`"--msg <text>"`); `target` is the
 * attribute name of the canonical option (`"message"`). The alias never wins over
 * an explicitly given canonical value.
 *
 * Commander validates `requiredOption`s BEFORE preAction hooks run, so an alias
 * cannot satisfy a required option: make the canonical option optional and check
 * for it in the action instead.
 */
export function aliasOption(command: Command, flags: string, target: string): Command {
  const option = new Option(flags).hideHelp();
  command.addOption(option);
  const source = option.attributeName();
  command.hook("preAction", (_this, actionCommand) => {
    const opts = actionCommand.opts();
    const value = opts[source];
    if (value === undefined) return;
    const current = opts[target];
    if (current === undefined || (Array.isArray(current) && current.length === 0)) {
      actionCommand.setOptionValue(target, value);
    } else if (Array.isArray(current) && Array.isArray(value)) {
      actionCommand.setOptionValue(target, [...current, ...value]);
    }
  });
  return command;
}

/** Several aliases for one canonical option. */
export function aliasOptions(command: Command, target: string, ...flags: string[]): Command {
  for (const f of flags) aliasOption(command, f, target);
  return command;
}
