export interface LocalFileLink {
  /** Absolute path on the computer the chat runs on. */
  path: string;
  line?: number;
}

export function isWindowsPath(path: string): boolean;
export function fileLinkName(path: string): string;
export function fileLinkFolder(path: string): string;
export function localFileLink(href: string, root?: string): LocalFileLink | null;
export function isMarkdownFile(name: string): boolean;

export interface FileLinkTarget {
  /** Relative to the chat's folder. */
  path: string;
  line?: number;
  column?: number;
}

export function fileLinkTarget(code: string): FileLinkTarget | null;
export function touchedFileMatches(relative: string, steps: readonly { file?: string; files?: readonly string[] }[]): string[];
