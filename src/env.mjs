import { existsSync } from 'node:fs';

/**
 * Load a .env file into process.env, if there is one.
 *
 * Uses Node's own `process.loadEnvFile` rather than a dotenv dependency: this
 * repo has no runtime dependencies and a .env parser is not worth breaking that
 * for. Available since Node 20.12 / 21.7; package.json already requires 22.
 *
 * Existing environment variables win. Exporting a variable in the shell should
 * override the file, not be silently replaced by it, which is the behaviour you
 * want when debugging with a second set of credentials.
 */
export function loadEnv(path = '.env') {
  if (!existsSync(path)) return false;

  const before = { ...process.env };
  process.loadEnvFile(path);
  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value;
  }
  return true;
}
