// Global switches are parsed locally. Command switches are checked against the selected owner's/scoped schema.
function parseCommandArgs(args) {
  const values = {},
    positionals = [],
    flags = [];
  const strings = new Set(["data-dir", "chat", "input", "channel"]);
  const booleans = new Set(["help", "version", "json", "no-pair", "no-qr", "stdio"]);
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-h") arg = "--help";
    if (arg === "-v") arg = "--version";
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown option: ${arg}`);
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    if (booleans.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} does not take a value`);
      values[name] = true;
      continue;
    }
    const raw = inline ?? (args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[++i] : true);
    if (strings.has(name)) {
      if (raw === true) throw new Error(`--${name} requires a value`);
      if (name === "channel") (values.channel ??= []).push(raw);
      else {
        if (Object.hasOwn(values, name)) throw new Error(`Repeated flag: --${name}`);
        values[name] = raw;
      }
    } else flags.push([name, raw]);
  }
  if (positionals[0] === "serve") {
    for (const [name, value] of flags) {
      if (name !== "project" || value === true) throw new Error(`Unknown or missing serve option: --${name}`);
      (values.project ??= []).push(value);
    }
    flags.length = 0;
  }
  return { values, positionals, flags };
}
module.exports = { parseCommandArgs };
