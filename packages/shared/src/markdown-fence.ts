export function isMarkdownFence(info: string | undefined): boolean {
  const language = info?.trim().split(/\s+/)[0]?.toLowerCase();
  return language === "markdown" || language === "md";
}
