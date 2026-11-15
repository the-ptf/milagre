// The phone design system (apps/mobile/DESIGN.md) as an Oxlint JS plugin. .oxlintrc.json turns every rule on as an
// error for apps/mobile/src, except the files that define the tokens (design-tokens.ts, theme.ts, press-style.ts),
// tests and generated files. There is no baseline: a real exception is one line,
//   // oxlint-disable-next-line milagre-design/<rule> -- <why>
// and `disable-reason` refuses a disable without the reason, a file-wide disable and a blanket disable.
//
// The rules read the AST, not text: a value counts when it is a literal written as the value of a style property, or
// a branch of one (`a ? 12 : 16`, `a && 12`, `a ?? 12`, `12 as const`). Arithmetic on tokens (`type.body * scale`,
// `space.lg - 2`) and values read from variables are not checked.

/** Strips TypeScript wrappers and yields every value an expression can take: both branches of a ternary, the right of
 * `&&`, both sides of `||` and `??`, and with `deep` each element of an array or value of an object, one level down
 * (`colors={[a, b]}`, `trackColor={{ true: a }}`). */
function* leaves(node, deep = false) {
  if (!node) return;
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
    case "ParenthesizedExpression":
      yield* leaves(node.expression, deep);
      return;
    case "ConditionalExpression":
      yield* leaves(node.consequent, deep);
      yield* leaves(node.alternate, deep);
      return;
    case "LogicalExpression":
      if (node.operator !== "&&") yield* leaves(node.left, deep);
      yield* leaves(node.right, deep);
      return;
    case "ArrayExpression":
      if (!deep) break;
      for (const element of node.elements) if (element && element.type !== "SpreadElement") yield* leaves(element);
      return;
    case "ObjectExpression":
      if (!deep) break;
      for (const property of node.properties) if (property.type === "Property") yield* leaves(property.value);
      return;
  }
  yield node;
}

/** The number a literal leaf is (`12`, `-4`), or undefined. */
function numberOf(node) {
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const inner = numberOf(node.argument);
    if (inner !== undefined) return node.operator === "-" ? -inner : inner;
  }
  return undefined;
}

/** The text a literal leaf is (a string, or a template literal with no `${}`), or undefined. */
function stringOf(node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  return undefined;
}

/** The name of a property in an object literal (`{ fontSize: … }`, `{ "fontSize": … }`), or undefined for a
 * destructuring pattern, a computed key or a method. */
function propertyName(node) {
  if (node.type !== "Property" || node.computed || node.method || node.kind !== "init") return undefined;
  if (node.parent && node.parent.type !== "ObjectExpression") return undefined;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string") return node.key.value;
  return undefined;
}

/** A JSX attribute's name and its value expression (a string attribute is its Literal). */
function attribute(node) {
  if (node.name.type !== "JSXIdentifier") return undefined;
  const value = node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
  if (!value || value.type === "JSXEmptyExpression") return undefined;
  return { name: node.name.name, value };
}

/** One visitor for both object-literal style properties and JSX attributes whose name passes `match`. */
function styleValues(match, { jsx = false } = {}) {
  return (check) => {
    const visitor = {
      Property(node) {
        const name = propertyName(node);
        if (name !== undefined && match(name)) check(name, node.value, node);
      },
    };
    if (jsx)
      visitor.JSXAttribute = (node) => {
        const found = attribute(node);
        if (found && match(found.name)) check(found.name, found.value, node);
      };
    return visitor;
  };
}

const rule = (description, message, create) => ({ meta: { type: "problem", docs: { description }, messages: { default: message } }, create });

// 1. Type: { fontSize: type.body, lineHeight: lineHeight.body }.
const fontSizeToken = rule(
  "fontSize and lineHeight come from the type and lineHeight tokens",
  "{{name}}: {{value}} is a literal. Use `{{token}}.*` from design-tokens.ts (DESIGN.md, Type).",
  (context) =>
    styleValues((name) => name === "fontSize" || name === "lineHeight")((name, value) => {
      for (const leaf of leaves(value)) {
        const n = numberOf(leaf);
        if (n !== undefined)
          context.report({ node: leaf, messageId: "default", data: { name, value: String(n), token: name === "fontSize" ? "type" : "lineHeight" } });
      }
    }),
);

// 2. Radius: radius.chip/control/card/sheet/composer/full; 0 is no corner. Also a primitive's `radius` prop
// (`<GlassSurface radius={20} />`).
const RADIUS_PROPERTY =
  /^(?:border(?:Top|Bottom|Start|End)?(?:Left|Right|Start|End)?Radius|border(?:Start|End)(?:Start|End)Radius|sheetCornerRadius|radius|cornerRadius)$/;
const radiusToken = rule(
  "Corner radii come from the radius tokens",
  "{{name}}: {{value}} is a literal. Use `radius.*` (chip 6, control 10, card 14, sheet 20, composer 24, full 999) from design-tokens.ts.",
  (context) =>
    styleValues((name) => RADIUS_PROPERTY.test(name), { jsx: true })((name, value) => {
      for (const leaf of leaves(value)) {
        const n = numberOf(leaf);
        if (n !== undefined && n !== 0) context.report({ node: leaf, messageId: "default", data: { name, value: String(n) } });
      }
    }),
);

// 3. Spacing: the 4 pt grid, plus 2 and 6 inside dense rows.
const SPACING_PROPERTY =
  /^(?:(?:padding|margin)(?:Top|Bottom|Left|Right|Horizontal|Vertical|Start|End|Block|BlockStart|BlockEnd|Inline|InlineStart|InlineEnd)?|gap|rowGap|columnGap)$/;
const onGrid = (n) => Number.isInteger(n) && (n % 4 === 0 || Math.abs(n) === 2 || Math.abs(n) === 6);
const spacingGrid = rule(
  "Spacing sits on the 4 pt grid (2 and 6 only in dense rows)",
  "{{name}}: {{value}} is off the 4 pt grid. Use `space.*` (xxs 2, xs 4, sm 6, md 8, lg 12, xl 16, xxl 24, xxxl 32) from design-tokens.ts.",
  (context) =>
    styleValues((name) => SPACING_PROPERTY.test(name))((name, value) => {
      for (const leaf of leaves(value)) {
        const n = numberOf(leaf);
        if (n !== undefined && !onGrid(n)) context.report({ node: leaf, messageId: "default", data: { name, value: String(n) } });
      }
    }),
);

// 4. Colour: useTheme().colors, never a literal.
const NAMED_COLORS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  ),
);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION = /^\s*(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const isRawColor = (text) => HEX.test(text.trim()) || COLOR_FUNCTION.test(text) || NAMED_COLORS.has(text.trim().toLowerCase());
/** Style props and JSX props that take a colour: anything ending in Color/Colors (`borderTopColor`, `colors` for a
 * gradient, `trackColor`), plus `fill`, `stroke`, `tint`. `transparent` is not a colour and stays allowed. */
const COLOR_PROPERTY = /^(?:color|colors|fill|stroke|tint|\w+Colou?rs?(?:Android|IOS)?|ios_backgroundColor)$/;
const noRawColor = rule(
  "Colours come from useTheme().colors",
  "{{value}} is a raw colour. Use a `useTheme().colors` key (DESIGN.md, Colour); the phone's own literals live in theme.ts.",
  (context) => {
    const seen = new Set();
    const report = (node, value) => {
      if (seen.has(node)) return;
      seen.add(node);
      context.report({ node, messageId: "default", data: { value: JSON.stringify(value) } });
    };
    return {
      ...styleValues((name) => COLOR_PROPERTY.test(name), { jsx: true })((_name, value) => {
        for (const leaf of leaves(value, true)) {
          const text = stringOf(leaf);
          if (text !== undefined && isRawColor(text)) report(leaf, text);
        }
      }),
      // A hex or rgb()/hsl() string anywhere (`const SCRIM = "#00000066"`): unambiguous outside a colour prop too.
      Literal(node) {
        if (typeof node.value === "string" && (HEX.test(node.value) || COLOR_FUNCTION.test(node.value)) && node.parent?.type !== "ImportDeclaration")
          report(node, node.value);
      },
      TemplateLiteral(node) {
        const text = stringOf(node);
        if (text !== undefined && (HEX.test(text) || COLOR_FUNCTION.test(text))) report(node, text);
      },
    };
  },
);

// 5. Elevation: boxShadow tokens from theme.ts.
const shadowToken = rule(
  "Elevation is colors.shadowCard / shadowRaised / shadowOverlay",
  "{{name}}: {{value}} is a hand-made shadow. Use `boxShadow: colors.shadowCard | shadowRaised | shadowOverlay` from theme.ts (DESIGN.md, Elevation).",
  (context) =>
    styleValues((name) => /^(?:boxShadow|shadowOpacity|shadowRadius|shadowOffset|elevation)$/.test(name))((name, value) => {
      for (const leaf of leaves(value)) {
        if (name === "boxShadow") {
          if (leaf.type === "Literal" || leaf.type === "TemplateLiteral" || leaf.type === "ArrayExpression" || leaf.type === "ObjectExpression")
            context.report({ node: leaf, messageId: "default", data: { name, value: leaf.type === "Literal" ? JSON.stringify(leaf.value) : "a literal" } });
          continue;
        }
        if (name === "shadowOffset") {
          const zero = leaf.type === "ObjectExpression" && leaf.properties.every((p) => p.type === "Property" && numberOf(p.value) === 0);
          if (leaf.type === "ObjectExpression" && !zero) context.report({ node: leaf, messageId: "default", data: { name, value: "a literal" } });
          continue;
        }
        const n = numberOf(leaf);
        if (n !== undefined && n !== 0) context.report({ node: leaf, messageId: "default", data: { name, value: String(n) } });
      }
    }),
);

// 6. Opacity: pressStyle's PRESSED_OPACITY and DISABLED_OPACITY.
const opacityToken = rule(
  "Press and disabled opacity come from pressStyle",
  "opacity: {{value}} is a literal. Use `pressStyle` / `PRESSED_OPACITY` (0.6) / `DISABLED_OPACITY.control|row` (0.4, 0.6) from primitives/press-style.ts; a colour's alpha belongs in the palette.",
  (context) =>
    styleValues((name) => name === "opacity")((_name, value) => {
      for (const leaf of leaves(value)) {
        const n = numberOf(leaf);
        if (n !== undefined && n !== 0 && n !== 1) context.report({ node: leaf, messageId: "default", data: { value: String(n) } });
      }
    }),
);

// 7. Weight: regular (400) for body text, 500 and 600; 700 only on the large title.
const fontWeight = rule(
  "Font weights are 400, 500 and 600; 700 only on largeTitle",
  "fontWeight: {{value}} is off the scale. Use 500 or 600 (400/normal for regular text); 700 is only for `type.largeTitle` (DESIGN.md, Type).",
  (context) => {
    const allowed = new Set(["400", "normal", "500", "600"]);
    return styleValues((name) => name === "fontWeight")((_name, value, property) => {
      const sibling = property.parent?.properties?.find((p) => propertyName(p) === "fontSize");
      const source = context.sourceCode.getText(value) + (sibling ? context.sourceCode.getText(sibling.value) : "");
      for (const leaf of leaves(value)) {
        const raw = stringOf(leaf) ?? (numberOf(leaf) !== undefined ? String(numberOf(leaf)) : undefined);
        if (raw === undefined || allowed.has(raw)) continue;
        if ((raw === "700" || raw === "bold") && source.includes("largeTitle")) continue;
        context.report({ node: leaf, messageId: "default", data: { value: JSON.stringify(raw) } });
      }
    });
  },
);

// 8. Glass: only GlassSurface and EdgeFade touch the blur library.
const BLUR = "@sbaiahmed1/react-native-blur";
const GLASS_FILES = [/[\\/]primitives[\\/]glass-surface\.tsx$/, /[\\/]src[\\/]bottom-fade\.tsx$/];
const glassPrimitive = rule(
  "Only GlassSurface and EdgeFade import the blur library",
  "Don't import {{source}} here. Draw glass with `GlassSurface` (primitives/glass-surface.tsx) and edge blur with `EdgeFade` (bottom-fade.tsx).",
  (context) => {
    const filename = context.filename ?? context.getFilename();
    if (GLASS_FILES.some((pattern) => pattern.test(filename))) return {};
    const check = (node, source) => {
      if (source && stringOf(source) === BLUR) context.report({ node, messageId: "default", data: { source: BLUR } });
    };
    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") check(node, node.arguments[0]);
      },
    };
  },
);

// 9. Roles: Android throws on an accessibilityRole it doesn't know (ReactAccessibilityDelegate.AccessibilityRole), so
// "status" turned a screen red. `role` is not checked: Android ignores a Role it doesn't know, and @expo/ui's
// SwiftUI buttons take their own `role` ("destructive", "cancel").
const ACCESSIBILITY_ROLES = new Set(
  "none button dropdownlist togglebutton link search image keyboardkey text adjustable imagebutton header summary alert checkbox combobox menu menubar menuitem progressbar radio radiogroup scrollbar spinbutton switch tab tabbar tablist timer list toolbar grid pager scrollview horizontalscrollview viewgroup webview drawerlayout slidingdrawer iconmenu".split(
    " ",
  ),
);
const accessibilityRole = rule(
  "accessibilityRole takes a value React Native supports on Android",
  '{{name}}="{{value}}" is not a React Native AccessibilityRole; Android rejects it with a red screen. For a line that changes use `accessibilityLiveRegion="polite"` or `announce()` (DESIGN.md, Announcements and roles).',
  (context) =>
    styleValues((name) => name === "accessibilityRole", { jsx: true })((name, value) => {
      for (const leaf of leaves(value)) {
        const text = stringOf(leaf);
        if (text !== undefined && !ACCESSIBILITY_ROLES.has(text)) context.report({ node: leaf, messageId: "default", data: { name, value: text } });
      }
    }),
);

// 10. Words: the other machine is "your computer", never "your Mac" (the desktop runs on macOS, Windows and Linux).
const MAC = /\bMac\b/;
const COPY_PROPS = new Set([
  "title",
  "label",
  "message",
  "placeholder",
  "accessibilityLabel",
  "accessibilityHint",
  "subtitle",
  "description",
  "hint",
  "footnote",
]);
const COPY_CALLS = new Set(["announce", "showToast", "toast", "alert", "prompt"]);
const copyComputer = rule(
  'Copy says "your computer", never "Mac"',
  '"{{text}}" says Mac. Say "your computer" or "computer": the desktop runs on macOS, Windows and Linux (DESIGN.md, Words).',
  (context) => {
    const check = (node) => {
      for (const leaf of leaves(node, true)) {
        const parts = leaf.type === "TemplateLiteral" ? leaf.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw) : [stringOf(leaf)];
        const text = parts.find((part) => part !== undefined && MAC.test(part));
        if (text !== undefined) context.report({ node: leaf, messageId: "default", data: { text: text.trim().slice(0, 60) } });
      }
    };
    return {
      JSXText(node) {
        if (MAC.test(node.value)) context.report({ node, messageId: "default", data: { text: node.value.trim().slice(0, 60) } });
      },
      JSXExpressionContainer(node) {
        if (node.parent?.type === "JSXElement" || node.parent?.type === "JSXFragment") check(node.expression);
      },
      ...styleValues((name) => COPY_PROPS.has(name), { jsx: true })((_name, value) => check(value)),
      CallExpression(node) {
        const callee = node.callee.type === "MemberExpression" && !node.callee.computed ? node.callee.property : node.callee;
        if (callee.type === "Identifier" && COPY_CALLS.has(callee.name)) for (const argument of node.arguments) check(argument);
      },
    };
  },
);

// 11. Native header buttons: SF Symbols exist only on iOS.
const isPlatformOS = (node) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === "Platform" &&
  node.property.type === "Identifier" &&
  node.property.name === "OS";
/** "ios" when `test` being true means iOS, "other" when it means not iOS, else undefined. Reads `Platform.OS ===
 * "ios"`, `!== "android"` and their negations, and an `&&` chain holding one of them. */
function platformOf(test) {
  if (!test) return undefined;
  if (test.type === "UnaryExpression" && test.operator === "!") {
    const inner = platformOf(test.argument);
    return inner === "ios" ? "other" : inner === "other" ? "ios" : undefined;
  }
  if (test.type === "LogicalExpression" && test.operator === "&&")
    return platformOf(test.left) === "ios" || platformOf(test.right) === "ios" ? "ios" : undefined;
  if (test.type === "LogicalExpression" && test.operator === "||")
    return platformOf(test.left) === "other" || platformOf(test.right) === "other" ? "other" : undefined;
  if (test.type !== "BinaryExpression" || !["===", "==", "!==", "!="].includes(test.operator)) return undefined;
  const [os, other] = isPlatformOS(test.left) ? [test.left, test.right] : isPlatformOS(test.right) ? [test.right, test.left] : [];
  const value = os && stringOf(other);
  if (value === undefined) return undefined;
  const equal = test.operator === "===" || test.operator === "==";
  if (value === "ios") return equal ? "ios" : "other";
  return equal ? "other" : "ios";
}
const ends = (node) =>
  node && (node.type === "ReturnStatement" || node.type === "ThrowStatement" || (node.type === "BlockStatement" && ends(node.body.at(-1))));
/** Whether `node` only runs on iOS: a ternary, `&&` or `if` on Platform.OS above it, or an earlier `if (not iOS) return`
 * in a function around it. */
function onlyOnIos(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type === "ConditionalExpression" || parent.type === "IfStatement") {
      const side = platformOf(parent.test);
      if (side === "ios" && parent.consequent === child) return true;
      if (side === "other" && parent.alternate === child) return true;
    }
    if (parent.type === "LogicalExpression" && parent.operator === "&&" && parent.right === child && platformOf(parent.left) === "ios") return true;
    if (parent.type === "BlockStatement" || parent.type === "Program") {
      for (const statement of parent.body) {
        if (statement === child) break;
        if (statement.type === "IfStatement" && platformOf(statement.test) === "other" && ends(statement.consequent)) return true;
      }
    }
  }
  return false;
}
const isToolbarButton = (name) =>
  name.type === "JSXMemberExpression" &&
  name.property.name === "Button" &&
  name.object.type === "JSXMemberExpression" &&
  name.object.property.name === "Toolbar" &&
  name.object.object.type === "JSXIdentifier" &&
  name.object.object.name === "Stack";
const toolbarIcon = rule(
  "Stack.Toolbar.Button with an SF Symbol renders only on iOS",
  'Stack.Toolbar.Button icon is an SF Symbol, which Android drops. Put it under `Platform.OS === "ios" ? … :` and give Android a `Stack.Toolbar.View` holding a `HeaderButton` (DESIGN.md, Native header buttons).',
  (context) => ({
    JSXOpeningElement(node) {
      if (!isToolbarButton(node.name)) return;
      const icon = node.attributes.find((a) => a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === "icon");
      const value = icon && attribute(icon)?.value;
      if (!value || ![...leaves(value)].some((leaf) => stringOf(leaf) !== undefined || leaf.type === "TemplateLiteral")) return;
      if (!onlyOnIos(node.parent)) context.report({ node: icon, messageId: "default" });
    },
  }),
);

// The way out of every rule is one documented line: `oxlint-disable-next-line milagre-design/<rule> -- <why>`.
const DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(-next-line|-line)?\b(.*)$/s;
const disableReason = rule(
  "A design-system exception is one disable-next-line with a reason",
  "{{problem}} Write `// oxlint-disable-next-line milagre-design/<rule> -- <why>` on the line before the exception.",
  (context) => ({
    Program() {
      for (const comment of context.sourceCode.getAllComments()) {
        const match = DIRECTIVE.exec(comment.value);
        if (!match) continue;
        const [, kind, rest] = match;
        const [rules, reason] = rest.split(/\s--\s?/, 2);
        const named = rules.trim();
        const ours = named === "" || /milagre-design\//.test(named);
        if (!ours) continue;
        let problem;
        if (named === "") problem = "A blanket disable also turns off the design-system rules; name the rules.";
        else if (kind !== "-next-line") problem = "A design-system exception covers one line, not a file or a range.";
        else if (!reason?.trim()) problem = "A design-system exception needs a reason after ` -- `.";
        if (problem) context.report({ loc: comment.loc, messageId: "default", data: { problem } });
      }
    },
  }),
);

export default {
  meta: { name: "milagre-design" },
  rules: {
    "font-size-token": fontSizeToken,
    "radius-token": radiusToken,
    "spacing-grid": spacingGrid,
    "no-raw-color": noRawColor,
    "shadow-token": shadowToken,
    "opacity-token": opacityToken,
    "font-weight": fontWeight,
    "glass-primitive": glassPrimitive,
    "accessibility-role": accessibilityRole,
    "copy-computer": copyComputer,
    "toolbar-icon": toolbarIcon,
    "disable-reason": disableReason,
  },
};
