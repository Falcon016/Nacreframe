/**
 * Imported first by the CLI, before React loads: React reads NODE_ENV once, when it is first imported. Without
 * this the development build runs, which is slower and prints developer warnings into the user's terminal. Tests
 * (NODE_ENV=test) and anyone who sets NODE_ENV themselves keep their choice.
 */
const setHere = process.env.NODE_ENV === undefined;
if (setHere) process.env.NODE_ENV = 'production';

/**
 * Put NODE_ENV back once React has loaded. Commands the agent runs inherit this environment, and a stray
 * NODE_ENV=production would, for one, make `npm install` skip a project's dev dependencies.
 */
export function restoreNodeEnv(): void {
  if (setHere) delete process.env.NODE_ENV;
}
