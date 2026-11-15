export type TerminalInfo = {
  id: string;
  chatId: string;
  title: string;
  cwd: string;
  label: string;
  busy: boolean;
  cols: number;
  rows: number;
  createdAt: number;
};
export type TerminalList = { terminals: TerminalInfo[] };
export type TerminalShell = { file: string; label: string };
export type TerminalProfiles = { shells: TerminalShell[]; defaultShell: string; selectedShell: string | null };
export type TerminalRead = { offset: number; data: string; reset: boolean; ended: boolean; terminal?: TerminalInfo };
export interface TerminalApi {
  profiles(): Promise<TerminalProfiles>;
  setShell(request: { shell: string | null }): Promise<TerminalProfiles>;
  list(request: { chatId: string }): Promise<TerminalList>;
  open(request: { chatId: string; cwd?: string; cols?: number; rows?: number }): Promise<TerminalInfo>;
  /** `limit` caps the characters returned; a host that predates it ignores it. */
  read(request: { terminalId: string; after: number; limit?: number }): Promise<TerminalRead>;
  input(request: { terminalId: string; data: string }): Promise<{ accepted: boolean }>;
  resize(request: { terminalId: string; cols: number; rows: number }): Promise<null>;
  close(request: { terminalId: string }): Promise<null>;
}
