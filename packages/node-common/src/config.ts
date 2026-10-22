import type { z } from 'zod';

/** Thrown when the environment doesn't satisfy the schema; lists every problem, not just the first. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** Parses `env` with `schema` and fails fast with every problem at once (conventions §10). */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.output<S> {
  // An empty variable means "not set", so defaults apply (as Compose often passes empty values).
  const set = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = schema.safeParse(set);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}
