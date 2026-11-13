import { lazyView } from "../lib/lazy-view";

// Views the window shows on request, each its own chunk, shared by the Project's workspace (App) and a Link's
// (LinkWorkspace): a static import in either would put them back in the first load. App preloads them once the window
// is idle (LAZY_VIEWS), so the first open shows at once.
export const DiffView = lazyView(() => import("./changes/DiffView").then((module) => module.DiffView));
export const GitActionsDialog = lazyView(() => import("./GitActionsDialog").then((module) => module.GitActionsDialog));
export const CommandPalette = lazyView(() => import("./CommandPalette").then((module) => module.CommandPalette));
export const QuestionCard = lazyView(() => import("./agents/QuestionCard").then((module) => module.QuestionCard));
