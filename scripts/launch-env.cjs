// What scripts/launch-electron.cjs hands to Electron. Pure, so it runs without an Electron download.

const DEV_SERVER = "--dev-server=";

/**
 * `--dev-server=<url>` replaces `MILAGRE_DEV_SERVER_URL=<url> node ...` in npm scripts, which cmd.exe can't run.
 * MILAGRE_USER_DATA_DIR gives a dev copy its own profile: the shared one would attach to an installed app's host
 * and can replace it, stopping its agents. ELECTRON_RUN_AS_NODE, inherited inside a Milagre Chat, would start Node instead of the app.
 */
function launchOptions(argv, env) {
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnv } = env;
  const args = [];
  for (const arg of argv) {
    if (arg.startsWith(DEV_SERVER)) launchEnv.MILAGRE_DEV_SERVER_URL = arg.slice(DEV_SERVER.length);
    else args.push(arg);
  }
  if (env.MILAGRE_USER_DATA_DIR) args.push(`--user-data-dir=${env.MILAGRE_USER_DATA_DIR}`);
  return { args, env: launchEnv };
}

module.exports = { launchOptions };
