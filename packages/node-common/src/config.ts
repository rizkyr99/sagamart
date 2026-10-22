import type { z } from 'zod';

/** Thrown when the environment doesn't satisfy the schema; lists every problem, not just the first. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** Parses `env` with `schema` and fails fast with every problem at once (conventions §10). */
export function loadConfig<S extends z.ZodType>(_schema: S, _env: NodeJS.ProcessEnv = process.env): z.output<S> {
  throw new Error('not implemented');
}
