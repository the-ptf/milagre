// The two env rules from eslint-plugin-expo, as an Oxlint JS plugin. Expo inlines

function isProcessEnv(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    node.property.type === "Identifier" &&
    node.property.name === "env"
  );
}

const noEnvVarDestructuring = {
  meta: { type: "problem", messages: { destructuring: "Read process.env.{{name}} directly; Expo cannot inline a destructured env var." } },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !isProcessEnv(node.init)) return;
        for (const property of node.id.properties) {
          const name = property.type === "Property" && property.key.type === "Identifier" ? property.key.name : "variables";
          context.report({ node: property, messageId: "destructuring", data: { name } });
        }
      },
    };
  },
};

const noDynamicEnvVar = {
  meta: { type: "problem", messages: { dynamic: "Read process.env.NAME with a static name; Expo cannot inline a computed env var." } },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed && isProcessEnv(node.object)) context.report({ node, messageId: "dynamic" });
      },
    };
  },
};

export default {
  meta: { name: "expo" },
  rules: { "no-env-var-destructuring": noEnvVarDestructuring, "no-dynamic-env-var": noDynamicEnvVar },
};
