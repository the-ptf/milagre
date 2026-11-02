export type KeybindingCommandId =
  | "commandPalette.toggle"
  | "chat.new"
  | "project.add"
  | "settings.open"
  | "theme.toggle"
  | "sidebar.toggle"
  | "canvas.open"
  | "usage.open"
  | "grid.toggle"
  | "grid.focusPrevious"
  | "grid.focusNext"
  | `chat.jump.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | "chat.find"
  | "dictation.toggle"
  | "changes.toggle"
  | "terminal.toggle"
  | "terminal.new"
  | "artifacts.toggle"
  | "designs.toggle"
  | "browser.toggle"
  | "simulator.toggle";

export interface KeybindingCommand {
  id: KeybindingCommandId;
  title: string;
  group: "General" | "Navigation" | "Chat" | "Panels";
  defaults: string[];
  /** The iPad's hardware keyboard offers it too. */
  mobile?: boolean;
  /** The desktop catches it before any frame, so it works with focus in an embedded frame. */
  forward?: boolean;
}

/** One line of keybindings.json. */
export interface KeybindingRule {
  key: string;
  command: KeybindingCommandId;
  when?: string;
}

/** A computer's keybindings, as its host reads keybindings.json. */
export interface KeybindingsState {
  /** The file's path on that computer. */
  path: string;
  rules: KeybindingRule[];
  /** A line per entry left out, or the reason the whole file was (then `rules` are the defaults). */
  issues: string[];
}

export interface KeyShortcut {
  key: string;
  mod: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type WhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: WhenNode }
  | { type: "and"; left: WhenNode; right: WhenNode }
  | { type: "or"; left: WhenNode; right: WhenNode };

export type WhenContext = Partial<Record<string, boolean>>;
export interface CompiledRule extends KeybindingRule {
  shortcut: KeyShortcut;
  whenTree?: WhenNode;
}
export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export const MAX_KEYBINDINGS: number;
export const KEYBINDING_COMMANDS: readonly KeybindingCommand[];
export const WHEN_KEYS: Readonly<Record<string, string>>;
export function keybindingCommand(id: string): KeybindingCommand | undefined;
export function defaultKeybindings(): KeybindingRule[];
export function defaultRulesFor(command: KeybindingCommandId): KeybindingRule[];
export function parseKey(value: unknown): KeyShortcut | null;
export function formatKey(shortcut: KeyShortcut): string;
export function canonicalKey(value: string, mac: boolean): string | null;
export function eventKey(event: KeyEventLike): string | null;
export function isModifierEvent(event: KeyEventLike): boolean;
export function keyFromEvent(event: KeyEventLike, mac: boolean): string | null;
export function eventMatches(event: KeyEventLike, shortcut: KeyShortcut, mac: boolean, either?: boolean): boolean;
export function hasCommandModifier(value: string): boolean;
export function keyLabelFor(value: string, mac: boolean): string | null;
export function parseWhen(value: unknown): WhenNode | null;
export function evaluateWhen(node: WhenNode, context: WhenContext): boolean;
export function whenNames(node: WhenNode | null | undefined): string[];
export function readRule(entry: unknown): { rule: KeybindingRule; error?: undefined } | { rule?: undefined; error: string };
export function readRules(value: unknown): { rules: KeybindingRule[]; issues: string[] };
export function compileRules(rules: readonly KeybindingRule[]): CompiledRule[];
export function commandForEvent(compiled: readonly CompiledRule[], event: KeyEventLike, context: WhenContext, mac: boolean): KeybindingCommandId | null;
export function keysFor(rules: readonly KeybindingRule[], command: KeybindingCommandId): string[];
export function primaryKeyFor(rules: readonly KeybindingRule[], command: KeybindingCommandId, context?: WhenContext): string | null;
export function conflictsFor(
  rules: readonly KeybindingRule[],
  rule: { key: string; command: KeybindingCommandId; when?: string },
  mac: boolean,
): KeybindingCommandId[];
export function withCommandRules(
  rules: readonly KeybindingRule[],
  command: KeybindingCommandId,
  next: ReadonlyArray<{ key: string; when?: string }>,
): KeybindingRule[];
export function isDefault(rules: readonly KeybindingRule[], command: KeybindingCommandId): boolean;
export function addNewDefaults(rules: readonly KeybindingRule[], seen: readonly string[]): { rules: KeybindingRule[]; seen: string[]; added: boolean };
