// Generate portable CLI contracts from the actual desktop bridge's contextual TypeScript types.
// Runtime does not load TypeScript or Electron. --check fails when bridge inputs drift.
const ts = require("typescript");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
function generate() {
  const file = path.join(root, "apps/desktop/electron/preload.cjs");
  const program = ts.createProgram([file], {
    allowJs: true,
    checkJs: true,
    strict: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const defs = {},
    cache = new Map();
  function schema(type) {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (type.flags & ts.TypeFlags.Never) return { not: {} };
    if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { type: "null" };
    if (type.flags & ts.TypeFlags.Null) return { type: "null" };
    if (type.isUnion()) {
      const types = type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
      const variants = types.map(schema);
      if (variants.every((s) => Object.hasOwn(s, "const"))) return { enum: variants.map((s) => s.const) };
      return variants.length === 1 ? variants[0] : { anyOf: variants };
    }
    if (type.isStringLiteral() || type.isNumberLiteral()) return { const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: type.intrinsicName === "true" };
    if (type.flags & ts.TypeFlags.StringLike) return { type: "string" };
    if (type.flags & ts.TypeFlags.NumberLike) return { type: "number" };
    if (type.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (cache.has(type)) return { $ref: `#/$defs/${cache.get(type)}` };
    if (checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type);
      return { type: "array", prefixItems: args.map(schema), minItems: type.target.minLength, maxItems: args.length };
    }
    if (checker.isArrayType(type)) return { type: "array", items: schema(checker.getTypeArguments(type)[0]) };
    const id = `T${cache.size + 1}`;
    cache.set(type, id);
    defs[id] = {};
    const properties = {},
      required = [];
    for (const prop of checker.getPropertiesOfType(type)) {
      // Symbol properties cannot be represented in JSON. TypeScript appends unstable internal IDs
      // (for example __@toStringTag@2221); they are neither wire fields nor portable contract names.
      if (prop.name.startsWith("__@")) continue;
      const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
      properties[prop.name] = schema(checker.getTypeOfSymbolAtLocation(prop, declaration));
      const description = ts.displayPartsToString(prop.getDocumentationComment(checker));
      if (description) properties[prop.name] = { ...properties[prop.name], description };
      const pt = checker.getTypeOfSymbolAtLocation(prop, declaration);
      if (!(prop.flags & ts.SymbolFlags.Optional) && !(pt.isUnion() && pt.types.some((t) => t.flags & ts.TypeFlags.Undefined))) required.push(prop.name);
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    defs[id] = { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: index ? schema(index) : false };
    return { $ref: `#/$defs/${id}` };
  }
  const commands = {};
  function visit(node) {
    if (ts.isCallExpression(node) && (node.expression.getText() === "invoke" || node.expression.getText() === "ipcRenderer.invoke") && node.arguments.length) {
      const first = node.arguments[0];
      let names = [];
      if (ts.isStringLiteral(first)) names = [first.text];
      else if (ts.isTemplateExpression(first)) {
        names = [first.head.text];
        for (const span of first.templateSpans) {
          const type = checker.getTypeAtLocation(span.expression);
          const variants = type.isUnion() ? type.types : [type];
          if (variants.some((t) => !t.isStringLiteral() && !t.isNumberLiteral())) throw new Error(`Cannot enumerate command channel: ${first.getText()}`);
          names = names.flatMap((prefix) => variants.map((t) => prefix + String(t.value) + span.literal.text));
        }
      } else if (!(node.expression.getText() === "ipcRenderer.invoke" && ts.isIdentifier(first) && first.text === "channel")) {
        throw new Error(`Cannot enumerate command channel: ${first.getText()}`);
      }
      if (names.length) {
        const parameters = node.arguments.slice(1).map((arg, i) => {
          const source = ts.isBinaryExpression(arg) && ts.isIdentifier(arg.left) ? arg.left : arg;
          const symbol = checker.getSymbolAtLocation(source);
          const declaration = symbol?.valueDeclaration;
          const optional =
            declaration &&
            ts.isParameter(declaration) &&
            (declaration.questionToken ||
              declaration.initializer ||
              (checker.getTypeAtLocation(arg).isUnion() && checker.getTypeAtLocation(arg).types.some((t) => t.flags & ts.TypeFlags.Undefined)));
          const name = ts.isIdentifier(source) ? source.text : i === 0 ? "request" : `options${i === 1 ? "" : i + 1}`;
          const fixed =
            ts.isObjectLiteralExpression(arg) &&
            arg.properties.every(
              (p) =>
                ts.isPropertyAssignment(p) &&
                [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral].includes(p.initializer.kind),
            );
          const defaultValue = fixed
            ? Object.fromEntries(
                arg.properties.map((p) => [
                  p.name.getText(),
                  p.initializer.kind === ts.SyntaxKind.TrueKeyword
                    ? true
                    : p.initializer.kind === ts.SyntaxKind.FalseKeyword
                      ? false
                      : ts.isNumericLiteral(p.initializer)
                        ? Number(p.initializer.text)
                        : p.initializer.text,
                ]),
              )
            : undefined;
          return {
            name,
            optional: Boolean(optional || fixed || source !== arg),
            ...(fixed ? { default: defaultValue } : {}),
            schema: schema(checker.getTypeAtLocation(arg)),
          };
        });
        for (const parameter of parameters)
          if (Object.keys(parameter.schema).length === 0) throw new Error(`Untyped command input: ${names[0]}.${parameter.name}`);
        for (const name of names) if (!commands[name] || commands[name].parameters.length <= parameters.length) commands[name] = { parameters };
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(program.getSourceFile(file));
  const native = [];
  const main = ts.createSourceFile("main.cjs", fs.readFileSync(path.join(root, "apps/desktop/electron/main.cjs"), "utf8"), ts.ScriptTarget.Latest, true);
  function nativeVisit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "ipcMain.handle" && ts.isStringLiteral(node.arguments[0]))
      native.push(node.arguments[0].text);
    ts.forEachChild(node, nativeVisit);
  }
  nativeVisit(main);
  return { commands, native: [...new Set(native)].sort(), $defs: defs };
}
function write(check = false) {
  const output = JSON.stringify(generate(), null, 2) + "\n";
  const target = path.join(root, "packages/core/src/command-contracts.json");
  if (check) {
    if (!require("node:util").isDeepStrictEqual(JSON.parse(fs.readFileSync(target, "utf8")), JSON.parse(output)))
      throw new Error("Command contracts changed. Run node scripts/generate-command-contracts.cjs.");
  } else fs.writeFileSync(target, output);
}
module.exports = { generate, write };
if (require.main === module) write(process.argv.includes("--check"));
