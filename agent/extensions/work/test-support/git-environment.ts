import { join } from "node:path";

const LOCAL_REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
] as const;

/** Make test Git processes independent from the user's Git configuration and credentials. */
export function testGitEnvironment(cwd: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }

  for (const name of LOCAL_REPOSITORY_VARIABLES) delete environment[name];
  delete environment["GIT_CONFIG_COUNT"];
  for (const name of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete environment[name];
  }

  environment["GIT_CONFIG_GLOBAL"] = join(cwd, ".gitconfig-test-empty");
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["GCM_INTERACTIVE"] = "never";
  environment["GIT_ASKPASS"] = "false";
  environment["SSH_ASKPASS"] = "false";
  return environment;
}
