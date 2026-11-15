import type { TerminalApi, TerminalInfo } from "./terminal.ts";

export type TerminalFollower = {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  stop(): void;
  readonly stopped: boolean;
};

export function followTerminal(options: {
  terminalId: string;
  api: Pick<TerminalApi, "read" | "input" | "resize">;
  write(data: string): unknown;
  reset(data: string): unknown;
  ended?(): void;
  info?(terminal: TerminalInfo): void;
  /** The most output one read carries; a reset carries the newest part. The host's whole kept output when unset. */
  readLimit?: number;
  retryMs?: number;
  wait?(ms: number): Promise<void>;
}): TerminalFollower;
