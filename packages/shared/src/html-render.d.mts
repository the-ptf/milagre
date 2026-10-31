export const HTML_RENDER_MESSAGE: string;
export const HTML_RENDER_MIN_HEIGHT: number;
export const HTML_RENDER_MAX_HEIGHT: number;
/** The reader's theme: colors as hex or CSS color functions, the chat text font, size in px and line height. */
export type HtmlRenderTheme = {
  scheme?: "light" | "dark";
  background?: string;
  surface?: string;
  field?: string;
  ink?: string;
  ink2?: string;
  muted?: string;
  line?: string;
  lineStrong?: string;
  accent?: string;
  accentInk?: string;
  accentTint?: string;
  onAccent?: string;
  green?: string;
  orange?: string;
  red?: string;
  purple?: string;
  font?: string;
  mono?: string;
  size?: number;
  leading?: number;
  /** Letter spacing in em. */
  tracking?: number;
};
export const HTML_RENDER_THEMES: { light: HtmlRenderTheme; dark: HtmlRenderTheme };
export type HtmlRenderMessage = { type: "size"; height: number } | { type: "link"; url: string } | { type: "escape" } | { type: "ready" };
export function htmlRenderHeight(height?: number): number;
export function readHtmlRenderMessage(value: unknown): HtmlRenderMessage | null;
export function htmlRenderShell(html: string, theme?: HtmlRenderTheme): string;
