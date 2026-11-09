export interface PowerSaveBlocker {
  start(type: "prevent-app-suspension"): number;
  isStarted(id: number): boolean;
  stop(id: number): void;
}
export class KeepAwake {
  constructor(options: { powerSaveBlocker: PowerSaveBlocker; enabled?: boolean });
  readonly isHolding: boolean;
  setEnabled(enabled: boolean): void;
  quit(): void;
}
