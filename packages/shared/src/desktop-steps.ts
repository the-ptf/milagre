import type { ChatStep } from "./model.ts";

/** A computer use step: one of Milagre's desktop_* tools (Settings › Experimental › Computer use). */
export const isDesktopStep = (step: ChatStep) => step.source?.server === "milagre" && !!step.source.name?.startsWith("desktop_");

type DesktopInput = { app?: string; action?: string; text?: string; keys?: string; intent?: string; role?: string; name?: string; window?: string };

const input = (step: ChatStep): DesktopInput => {
  try {
    const value = JSON.parse(step.input ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as DesktopInput) : {};
  } catch {
    return {};
  }
};

const ACTIONS: Record<string, string> = {
  click: "Clicked",
  type: "Typed",
  "set-value": "Set a value",
  clear: "Cleared a field",
  select: "Chose",
  toggle: "Toggled",
  check: "Checked",
  uncheck: "Unchecked",
  expand: "Expanded",
  collapse: "Collapsed",
  focus: "Focused",
  scroll: "Scrolled",
  "scroll-to": "Scrolled to",
};

/** The step in a few words: the agent's own intent when it gave one, otherwise what the tool did. */
export function desktopStepLabel(step: ChatStep): string {
  const value = input(step);
  if (value.intent?.trim()) return value.intent.trim();
  const app = value.app ?? "";
  switch (step.source?.name) {
    case "desktop_apps":
      return app ? `Listed ${app}'s windows` : "Listed the open apps";
    case "desktop_launch":
      return `Opened ${app}`;
    case "desktop_snapshot":
      return `Read ${app}`;
    case "desktop_find":
      return `Looked for ${value.name ?? value.text ?? value.role ?? "an element"}${app ? ` in ${app}` : ""}`;
    case "desktop_press":
      return `Pressed ${value.keys ?? "a key"}`;
    case "desktop_wait":
      return `Waited for ${value.text ? `"${value.text}"` : (value.window ?? "the app")}`;
    case "desktop_screenshot":
      return `Looked at ${app}`;
    case "desktop_act": {
      const verb = ACTIONS[value.action ?? ""] ?? "Acted";
      return ["type", "select"].includes(value.action ?? "") && value.text ? `${verb} "${value.text.slice(0, 40)}"` : verb;
    }
    default:
      return step.title;
  }
}

/** The apps the steps used, in the order they were first used. */
export function desktopStepApps(steps: ChatStep[]): string[] {
  const apps: string[] = [];
  for (const step of steps) {
    const app = input(step).app;
    if (app && !apps.includes(app)) apps.push(app);
  }
  return apps;
}

/** How long the host keeps capturing after the agent's last desktop step (computer-use-screen.cjs IDLE_MS), plus slack. */
const CAPTURE_TAIL_MS = 25_000;

/**
 * Whether the Chat's latest frame belongs to these steps: the host keeps one frame per Chat, so an earlier reply's card
 * shows it only when no later desktop work could have replaced it.
 */
export function frameFitsSteps(frameAt: number | undefined, steps: ChatStep[]): boolean {
  if (!frameAt || !steps.length) return false;
  const first = steps[0]!.startedAt;
  const running = steps.some((step) => step.status === "running");
  const last = Math.max(...steps.map((step) => step.endedAt ?? step.startedAt ?? 0));
  return (first === undefined || frameAt >= first - 1000) && (running || !last || frameAt <= last + CAPTURE_TAIL_MS);
}
