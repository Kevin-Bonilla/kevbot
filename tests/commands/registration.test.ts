import { describe, it, expect } from 'vitest';
import { slashCommands } from '../../src/commands/registry';

/**
 * Registration guard.
 *
 * Discord validates command payloads on registration, but a failure there is
 * only logged at runtime on the VM — the bot keeps running with stale commands
 * and nobody sees why. These checks move the cheap, deterministic part into
 * CI, and pin the two things that are easy to lose by accident:
 *
 *   1. Discord's documented limits (100 guild commands, 1-32 character
 *      lowercase names, 1-100 character descriptions, 25 options/choices).
 *   2. The channel restrictions the old `!` commands had. `/oopsie`,
 *      `/oopsiecounter`, `/debug` and `/purge` were kevins-ai-chamber-only
 *      message commands; the slash versions must stay that way.
 *
 * Limits from https://docs.discord.com/developers/interactions/application-commands
 */

/** Discord's CHAT_INPUT name regex (docs simplify the script classes here). */
const NAME_RE = /^[-_\u02BC\p{L}\p{N}]{1,32}$/u;

const MAX_GUILD_COMMANDS = 100;
const MAX_DESCRIPTION = 100;
const MAX_OPTIONS = 25;
const MAX_CHOICES = 25;

/**
 * kevins-ai-chamber: the one channel the restricted commands may be used in.
 *
 * Deliberately the literal, not an import from src/config/admin-channels.ts. The
 * point of this constant is to be a tripwire: editing the configured channel
 * is an operational change that should fail CI loudly, and importing the
 * value would make the assertion agree with whatever the config says.
 */
const RESTRICTED_CHANNEL_ID = '1552121753692667977';

/**
 * The full expected command list, and which are channel-bound. Kept explicit
 * (not derived from the registry) so adding or removing a command forces a
 * deliberate edit here — that is the review prompt, not a maintenance burden.
 */
const EXPECTED_COMMANDS: Record<string, { channelRestricted: boolean }> = {
  died: { channelRestricted: false },
  deathcounter: { channelRestricted: false },
  deathleaderboard: { channelRestricted: false },
  oopsie: { channelRestricted: true },
  oopsiecounter: { channelRestricted: true },
  purge: { channelRestricted: true },
  debug: { channelRestricted: true },
  github: { channelRestricted: false },
};

type OptionJson = {
  type: number;
  name: string;
  description?: string;
  required?: boolean;
  options?: OptionJson[];
  choices?: Array<{ name: string; value: string | number }>;
};

const bodies = slashCommands.map((command) => command.data.toJSON());

function optionBodies(options: OptionJson[] = [], path: string): void {
  expect(options.length, `${path}: option count`).toBeLessThanOrEqual(MAX_OPTIONS);

  const seen = new Set<string>();
  let optionalSeen = false;

  for (const option of options) {
    expect(option.name, `${path}: option name`).toMatch(NAME_RE);
    expect(option.name, `${path}: option name must be lowercase`).toBe(option.name.toLowerCase());
    expect(seen.has(option.name), `${path}: duplicate option ${option.name}`).toBe(false);
    seen.add(option.name);

    if (option.description !== undefined) {
      expect(option.description.length, `${path}.${option.name}: description`).toBeGreaterThanOrEqual(1);
      expect(option.description.length, `${path}.${option.name}: description`).toBeLessThanOrEqual(
        MAX_DESCRIPTION
      );
    }

    // Discord rejects required options that follow an optional one.
    if (option.type !== 1 && option.type !== 2) {
      if (option.required) {
        expect(optionalSeen, `${path}: required ${option.name} after an optional option`).toBe(false);
      } else {
        optionalSeen = true;
      }
    }

    if (option.choices !== undefined) {
      expect(option.choices.length, `${path}.${option.name}: choices`).toBeLessThanOrEqual(MAX_CHOICES);
    }

    if (option.options !== undefined) {
      optionBodies(option.options, `${path}.${option.name}`);
    }
  }
}

describe('slash command registry', () => {
  it('stays under Discord\'s 100 guild command cap', () => {
    expect(bodies.length).toBeLessThanOrEqual(MAX_GUILD_COMMANDS);
  });

  it('publishes exactly the commands we expect', () => {
    expect(bodies.map((b) => b.name).sort()).toEqual(Object.keys(EXPECTED_COMMANDS).sort());
  });

  it('has a unique, Discord-valid name and description for every command', () => {
    const names = new Set<string>();

    for (const body of bodies) {
      expect(body.name, 'name').toMatch(NAME_RE);
      expect(body.name, 'name must be lowercase').toBe(body.name.toLowerCase());
      expect(names.has(body.name), `duplicate command name: ${body.name}`).toBe(false);
      names.add(body.name);

      expect(body.type ?? 1, `${body.name}: type`).toBe(1);
      expect(body.description, `${body.name}: description`).toBeDefined();
      expect(body.description!.length, `${body.name}: description`).toBeGreaterThanOrEqual(1);
      expect(body.description!.length, `${body.name}: description`).toBeLessThanOrEqual(MAX_DESCRIPTION);

      optionBodies(body.options as OptionJson[] | undefined, body.name);
    }
  });

  it('keeps every command executable', () => {
    for (const command of slashCommands) {
      expect(typeof command.execute, `${command.data.name}: execute`).toBe('function');
    }
  });

  it('keeps the kevins-ai-chamber restrictions from the old message commands', () => {
    for (const body of bodies) {
      const expected = EXPECTED_COMMANDS[body.name];
      const command = slashCommands.find((c) => c.data.name === body.name)!;

      if (expected.channelRestricted) {
        expect(command.requiredChannelId, `${body.name} must be channel-restricted`).toBe(
          RESTRICTED_CHANNEL_ID
        );
      } else {
        expect(command.requiredChannelId, `${body.name} must stay unrestricted`).toBeUndefined();
      }
    }
  });

  it('exposes the purge as exactly two subcommands', () => {
    // The old trio (!purgeDryRun, !purge, !purge confirm) maps to one command;
    // a rename here would quietly break the documentation and the flow.
    const purge = bodies.find((b) => b.name === 'purge')!;
    const subcommands = (purge.options as OptionJson[]).map((option) => option.name);

    expect(subcommands).toEqual(['dry-run', 'preview']);
  });
});
