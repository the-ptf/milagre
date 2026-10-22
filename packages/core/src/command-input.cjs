const { z } = require("zod");
const generated = require("./command-contracts.json");
const overrides = require("./command-contract-overrides.cjs");
const validators = new WeakMap();
function withDefinitions(schema) {
  const defs = {};
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      const id = value.$ref.split("/").at(-1);
      if (!Object.hasOwn(defs, id)) {
        defs[id] = generated.$defs[id];
        visit(defs[id]);
      }
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(schema);
  return Object.keys(defs).length ? { ...schema, $defs: defs } : schema;
}
function resolve(schema, root) {
  return schema?.$ref ? resolve(root.$defs[schema.$ref.split("/").at(-1)], root) : schema;
}
function contractFor(name, { desktop = false } = {}) {
  const parameters = (!desktop && overrides[name]) || generated.commands[name]?.parameters;
  if (!parameters) throw new Error(`Missing command contract: ${name}`);
  const single = parameters.length === 1 && resolve(parameters[0].schema, generated).type === "object";
  const inputSchema = single
    ? { ...resolve(parameters[0].schema, generated) }
    : {
        type: "object",
        properties: Object.fromEntries(parameters.map((p) => [p.name, p.schema])),
        required: parameters.filter((p) => !p.optional).map((p) => p.name),
        additionalProperties: false,
      };
  return { parameters, inputSchema: withDefinitions(inputSchema), single };
}
function validate(schema, input) {
  let validator = validators.get(schema);
  if (!validator) {
    validator = z.fromJSONSchema(schema);
    validators.set(schema, validator);
  }
  const result = validator.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid arguments: ${result.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}${i.keys ? `: ${i.keys.join(", ")}` : ""}`).join("; ")}`,
    );
  return result.data;
}
function argumentsFor(contract, input) {
  if (Array.isArray(input)) {
    if (input.length > contract.parameters.length) throw new Error("Too many command arguments");
    // Legacy positional arrays use the same contract as named flags.
    input = contract.single
      ? (input[0] ?? {})
      : Object.fromEntries(contract.parameters.flatMap((p, i) => (input[i] === undefined ? [] : [[p.name, input[i]]])));
  }
  input = validate(contract.inputSchema, input ?? {});
  if (contract.single) return Object.keys(input).length === 0 && contract.parameters[0].optional ? [] : [input];
  const args = contract.parameters.map((p) => (Object.hasOwn(input, p.name) ? input[p.name] : p.default));
  while (args.length && args.at(-1) === undefined) args.pop();
  return args;
}
const reserved = new Set(["chat", "input", "channel", "json", "version", "help", "stdio", "dataDir", "noPair", "noQr"]);
const flagName = (name) => (reserved.has(name) ? "arg-" : "") + name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
function fieldsOf(schema) {
  const resolved = resolve(schema, schema);
  return resolved.properties ?? Object.assign({}, ...(resolved.anyOf ?? []).map((s) => fieldsOf({ ...resolve(s, schema), $defs: schema.$defs })));
}
function inputForFlags(schema, flags) {
  const fields = fieldsOf(schema),
    input = {};
  const seen = new Set();
  for (const [flag, raw] of flags) {
    const name = Object.keys(fields).find((name) => flagName(name) === flag);
    if (!name) throw new Error(`Unknown flag: --${flag}`);
    if (seen.has(name)) throw new Error(`Repeated flag: --${flag}. Use a JSON array for array inputs.`);
    seen.add(name);
    const field = resolve(fields[name], schema);
    const variants = field.anyOf?.map((s) => resolve(s, schema)) ?? [field];
    if (raw === "null" && variants.some((s) => s.type === "null")) input[name] = null;
    else if (variants.some((s) => s.type === "string" || s.enum?.some((v) => typeof v === "string") || typeof s.const === "string")) {
      if (raw === true) throw new Error(`--${flag} requires a value`);
      input[name] = raw;
    } else {
      try {
        input[name] = raw === true ? true : JSON.parse(raw);
      } catch {
        throw new Error(`--${flag} requires a valid ${field.type ?? "JSON"} value`);
      }
    }
  }
  return validate(schema, input);
}
module.exports = {
  ownerCommands: [...new Set([...Object.keys(generated.commands), ...Object.keys(overrides)])],
  contractInventory: generated,
  nativeCommands: generated.native,
  contractFor,
  argumentsFor,
  inputForFlags,
  flagName,
  fieldsOf,
  resolve,
  validate,
};
