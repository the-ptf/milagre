export type LinkActionId = "review" | "panel" | "browser" | "copy-link" | "share" | "preview" | "copy-path";

export type LinkSheetTarget = { kind: "web"; review: boolean; panel: boolean } | { kind: "file" };

/** The rows of a reply link's long-press sheet, in order; Cancel is the sheet's own. */
export function linkSheetActions(target: LinkSheetTarget, os: "ios" | "android" | string): { id: LinkActionId; title: string }[] {
  if (target.kind === "file")
    return [
      { id: "preview", title: "Preview" },
      { id: "copy-path", title: "Copy path" },
    ];
  return [
    ...(target.review ? [{ id: "review" as const, title: "Open in Code review" }] : []),
    ...(target.panel ? [{ id: "panel" as const, title: "Open in Browser panel" }] : []),
    { id: "browser", title: os === "ios" ? "Open in Safari" : "Open in browser" },
    { id: "copy-link", title: "Copy link" },
    { id: "share", title: "Share…" },
  ];
}
