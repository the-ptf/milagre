import { lazyView } from "../lib/lazy-view";

export const DiffView = lazyView(() => import("./changes/DiffView").then((module) => module.DiffView));
export const GitActionsDialog = lazyView(() => import("./GitActionsDialog").then((module) => module.GitActionsDialog));
export const CommandPalette = lazyView(() => import("./CommandPalette").then((module) => module.CommandPalette));
export const QuestionCard = lazyView(() => import("./agents/QuestionCard").then((module) => module.QuestionCard));
