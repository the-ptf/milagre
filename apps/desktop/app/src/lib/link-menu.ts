export type LinkMenuKey = "review" | "panel" | "browser" | "copy-link" | "copy-markdown" | "viewer" | "editor" | "reveal" | "copy-path" | "copy-relative-path";

export type LinkMenuRow = { key: LinkMenuKey; label: string; hint?: string };
export type LinkMenuEntry = LinkMenuRow | "divider";

export type WebLinkMenu = {
  kind: "web";
  pullRequest: boolean;
  openLinksIn: "milagre" | "external";
  panel: boolean;
};

export type FileLinkMenu = {
  kind: "file";
  editor?: string;
  remote: boolean;
  relative: boolean;
};

export type Platform = { mac: boolean; fileManager: string };

function gestures({ mac }: Platform) {
  return { click: "Click", mod: mac ? "⌘ Click" : "Ctrl+Click", shift: mac ? "⇧ Click" : "Shift+Click" };
}

/**
 * Where a plain click and a ⌘-click (Ctrl-click off macOS) on a web link go, as Markdown's Link and the Chat's PR capture
 * decide. Without a Browser panel to take it, a link meant for the panel opens in the default browser.
 */
export function webLinkHints(link: Omit<WebLinkMenu, "kind">, platform: Platform): Partial<Record<LinkMenuKey, string>> {
  const { click, mod, shift } = gestures(platform);
  const panel = link.panel ? "panel" : "browser";
  const plain = link.pullRequest ? "review" : link.openLinksIn === "milagre" ? panel : "browser";
  const modified = link.openLinksIn === "milagre" ? "browser" : panel;
  const hints: Partial<Record<LinkMenuKey, string>> = { [plain]: click };
  hints[modified] ??= mod;
  hints.browser ??= shift;
  return hints;
}

export function linkMenuEntries(link: WebLinkMenu | FileLinkMenu, platform: Platform): LinkMenuEntry[] {
  if (link.kind === "web") {
    const hints = webLinkHints(link, platform);
    const open: LinkMenuRow[] = [
      ...(link.pullRequest ? [{ key: "review" as const, label: "Code review" }] : []),
      ...(link.panel ? [{ key: "panel" as const, label: "Browser panel" }] : []),
      { key: "browser", label: "Default browser" },
    ];
    return [
      ...open.map((row) => ({ ...row, ...(hints[row.key] ? { hint: hints[row.key] } : {}) })),
      "divider",
      { key: "copy-link", label: "Copy link" },
      { key: "copy-markdown", label: "Copy as Markdown" },
    ];
  }
  const local = !link.remote;
  return [
    { key: "viewer", label: "File viewer", hint: gestures(platform).click },
    ...(local && link.editor ? [{ key: "editor" as const, label: link.editor }] : []),
    ...(local ? [{ key: "reveal" as const, label: platform.mac ? "Reveal in Finder" : `Show in ${platform.fileManager}` }] : []),
    "divider",
    { key: "copy-path", label: "Copy path" },
    ...(link.relative ? [{ key: "copy-relative-path" as const, label: "Copy relative path" }] : []),
  ];
}

/** `[text](url)`, with the brackets and parentheses that would end the link escaped. */
export function markdownLink(text: string, url: string): string {
  const label = (text.trim() || url).replace(/[[\]\\]/g, "\\$&");
  return `[${label}](${url.replace(/[()\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`;
}
