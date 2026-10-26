export interface LocalFileLink {
  /** Absolute path on the computer the chat runs on. */
  path: string;
  line?: number;
}

export function localFileLink(href: string, root?: string): LocalFileLink | null;
export function isMarkdownFile(name: string): boolean;
