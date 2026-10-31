type FontArtifact = { format: string; html: string; version: number; fontKey?: string; fontCss?: string };
type Request = { chatId: string; id: string; version?: number; fonts?: { have: string[] } };
export type DesignFontReader<T> = ((request: Request) => Promise<T>) & { reconnect(): void };
export function createDesignFontReader<T extends FontArtifact>(get: (request: Request) => Promise<T>): DesignFontReader<T>;
export function restoreDesignFonts<T extends FontArtifact>(artifact: T): T;
