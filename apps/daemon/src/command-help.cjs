const GLOBAL_FLAGS = [
  ["--data-dir <path>", "Absolute profile path (MILAGRE_DATA_DIR or ~/.milagre/server)."],
  ["--help, -h", "Show command help."],
  ["--version, -v", "Show the CLI version."],
  ["--input <JSON|@file|->", "JSON arguments, a JSON file, or standard input."],
  ["--chat <chat>", "Existing Chat identity for scoped commands."],
  ["--json", "Print machine-readable JSON."],
];

const COMMANDS = {
  computers: {
    description: "Manage connections to other Milagre computers from the owning daemon.",
    usage: "milagre computers <command> [arguments] [flags]",
    commands: [
      ["list", "List saved computers and their connection state."],
      ["setup-key <file>", "Create or select a private 32-byte key file for unattended access."],
      ["add <link> [--name NAME]", "Pair with a computer. Its owner must approve."],
      ["rename <id> <name>", "Change a saved computer's local label."],
      ["remove <id>", "Remove a saved computer and disconnect it."],
      ["enable | disable", "Persist whether the daemon connects to saved computers."],
      ["cancel-add", "Cancel the pending pairing request."],
      ["invoke --input JSON", "Call a remote method with [computerId, method, args]."],
    ],
    examples: [
      "milagre computers setup-key /private/path/milagre-computer.key",
      "milagre computers enable",
      "milagre computers add 'milagre://pair?...' --name Studio",
      "milagre computers list",
    ],
    note: "Keep the key file separate from profile backups. A desktop can unlock its existing OS-sealed key; setup-key exports that unlocked key for unattended use. Existing pairings migrate when the updated desktop opens. Paired remote clients cannot manage this owner's computer connections.",
  },
  session: {
    description: "Keep an owner connection open for scripted commands and viewer controls.",
    usage: "milagre session",
    note: 'Read newline-delimited {"id":1,"method":"project:registry","args":[]} from stdin. Writes {id,result}, {id,error} and live {type:"event",...} records. EOF waits for accepted commands. Viewer capabilities last for this connection. Owner access only; MCP clients use mcp serve --stdio.',
  },
  desktop: {
    description: "Run a native command in a connected desktop using the same profile.",
    usage: "milagre desktop <family> <action> [flags]",
    examples: ["milagre desktop editor list", "milagre desktop computers list", "milagre desktop update state"],
    note: "Desktop entries appear in command list while connected. Headless hosts return CAPABILITY_UNAVAILABLE. Native handlers, encrypted credentials and user settings stay in their owning desktop.",
  },
  watch: {
    description: "Stream a snapshot followed by live events as newline-delimited JSON.",
    usage: "milagre watch [flags]",
    flags: [
      ["--chat <chat>", "Filter events to one Chat."],
      ["--channel <name>", "Filter event channels. Can be repeated."],
    ],
    examples: ["milagre watch", "milagre watch --chat '/project#1' --channel agent:event"],
    note: "Ctrl+C disconnects the viewer. Running agents keep working. Reconnect after a dropped connection for a fresh snapshot.",
  },
  mcp: {
    description: "Connect an MCP client to an existing scoped connection.",
    usage: "milagre mcp serve --stdio",
    flags: [["--stdio", "Forward JSON-RPC over standard input and output."]],
    note: "Uses MILAGRE_MCP_URL and MILAGRE_MCP_TOKEN from the connection created in MCP settings. Never grants owner access or starts another host.",
  },
  command: {
    description: "Discover product operations or run the same scoped commands as MCP.",
    usage: "milagre command <list|describe NAME|run NAME> [flags]",
    commands: [
      ["list", "List owner operations, or scoped commands with --chat."],
      ["describe <name>", "Describe a command and its input schema with --chat."],
      ["run <name>", "Run a scoped command. Requires --chat."],
    ],
    examples: [
      "milagre command list",
      "milagre project registry",
      "milagre command list --chat '/project#1'",
      "milagre command run tasks_read --chat '/project#1'",
      'milagre chat patch --input \'["/project",1,{"title":"Review"}]\'',
    ],
    note: "Product RPC names map to words: designs:enabled:read becomes milagre designs enabled read. Inputs use the existing positional JSON contract. Scoped commands use their published object schema and preserve agent permissions.",
  },
  serve: {
    description: "Run the server without a desktop UI and print pairing details.",
    usage: "milagre serve [flags]",
    flags: [
      ["--project <path>", "Open a Project on startup. Can be repeated."],
      ["--no-pair", "Keep existing device access without opening a pairing window."],
      ["--no-qr", "Print pairing links without terminal QR codes."],
    ],
    examples: ["milagre serve", "milagre serve --project /path/to/project", "milagre serve --no-pair"],
    note: "Runs in the foreground. Ctrl+C or SIGTERM saves and stops the server.",
  },
  pair: {
    description: "Open a new pairing window for phones and other desktops.",
    usage: "milagre pair [flags]",
    flags: [["--no-qr", "Print pairing links without terminal QR codes."]],
    examples: ["milagre pair", "milagre pair --no-qr"],
    note: "Pairing lasts 10 minutes. Approve computers with milagre devices allow KEY.",
  },
  status: {
    description: "Show the running server's status as JSON.",
    usage: "milagre status [flags]",
    examples: ["milagre status"],
  },
  stop: {
    description: "Save running work and stop the server.",
    usage: "milagre stop [flags]",
    examples: ["milagre stop"],
  },
  devices: {
    description: "List, approve and remove paired devices.",
    usage: "milagre devices <command> [key] [flags]",
    commands: [
      ["list", "List paired devices."],
      ["pending", "List computers waiting for approval."],
      ["allow <key>", "Approve a waiting computer."],
      ["deny <key>", "Reject a waiting computer."],
      ["remove <key>", "Remove a paired device and close its connections."],
    ],
    examples: ["milagre devices pending", "milagre devices allow KEY", "milagre devices list"],
  },
  triage: {
    description: "Investigate a Milagre problem on this computer with claude or codex, and help file a good issue.",
    usage: "milagre triage [flags]",
    flags: [["--agent <claude|codex>", "Agent CLI to use. Default: ask when both are installed."]],
    examples: ["npx milagre triage", "milagre triage --agent codex", "milagre triage --data-dir /absolute/profile"],
    note: "Works when the desktop app won't start. Writes the playbook and machine facts to a triage folder in the profile, then starts the agent there. It asks before it changes anything or posts an issue.",
  },
  request: {
    description: "Call a daemon method and print its result as JSON.",
    usage: "milagre request <method> [JSON_ARGS] [flags]",
    arguments: [
      ["method", "Daemon method to call, such as project:open or chat:runs."],
      ["JSON_ARGS", "Arguments as a JSON array. Defaults to []."],
    ],
    examples: ["milagre request project:open '[\"/path/to/project\"]'", "milagre request chat:runs"],
  },
  help: {
    description: "Show all commands or help for a specific command.",
    usage: "milagre help [command]",
    arguments: [["command", "Command to describe. Omit it to show all commands."]],
    examples: ["milagre help", "milagre help serve", "milagre serve --help"],
  },
};

function renderHelp(command, { color = false } = {}) {
  const info = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (command && !info) throw new Error(`Unknown command: ${command}. Use milagre help.`);
  const style = (code, value) => (color ? `\u001b[${code}m${value}\u001b[0m` : value);
  const sections = [];
  const section = (title, lines) => sections.push(`${style("1", title)}\n${lines.join("\n")}`);
  const rows = (entries) => {
    const width = Math.max(...entries.map(([name]) => name.length)) + 3;
    return entries.map(([name, description]) => `  ${style("36", name)}${" ".repeat(width - name.length)}${description}`);
  };
  section("DESCRIPTION", [`  ${info?.description ?? "Run Milagre agents on a computer without a desktop UI."}`]);
  section("USAGE", [`  ${style("36", info?.usage ?? "milagre <command> [flags]")}`]);
  if (info?.arguments) section("ARGUMENTS", rows(info.arguments));
  if (!info) section("COMMANDS", rows(Object.entries(COMMANDS).map(([name, entry]) => [name, entry.description])));
  if (info?.commands) section("COMMANDS", rows(info.commands));
  if (info?.flags) section("FLAGS", rows(info.flags));
  section("GLOBAL FLAGS", rows(GLOBAL_FLAGS));
  section(
    "EXAMPLES",
    (info?.examples ?? ["npx milagre serve", "milagre help serve", "milagre devices pending"]).map((example) => `  ${style("36", example)}`),
  );
  if (info?.note) section("NOTES", [`  ${info.note}`]);
  if (!info) section("REQUIRES", ["  Node.js 24+ and an installed, signed-in agent CLI (Claude Code or Codex)."]);
  return sections.join("\n\n") + "\n";
}

module.exports = { COMMANDS, renderHelp };
