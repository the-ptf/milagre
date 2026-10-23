export const PAGE_TTL_MS: number;
export const CHUNK_BYTES: number;
export const SECURITY_HEADERS: Record<string, string>;
export function response(body: BodyInit | null, status?: number, type?: string): Response;
export function digest(bytes: Uint8Array): Promise<string>;
export function authorized(request: Request, id: string): Promise<boolean>;
export function boundedBody(request: Request, limit?: number): Promise<Uint8Array>;
export interface Storage {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  keys(prefix: string): string[];
  transaction<T>(callback: () => T): T;
}
export interface PageQuota {
  available(id: string): number | Promise<number>;
  reserve(id: string, operation: string, bytes: number): boolean | Promise<boolean>;
  commit(id: string, operation: string): boolean | Promise<boolean>;
  abort(id: string, operation: string): void | Promise<void>;
  release(id: string): void | Promise<void>;
  importPage(id: string, bytes: number): void | Promise<void>;
}
export function createPageService<Snapshot>(options: {
  storage: Storage;
  validate(value: unknown): Snapshot;
  render(snapshot: Snapshot): string;
  quota: PageQuota;
  quotaId: string;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  now?: () => number;
}): { fetch(request: Request, id: string): Promise<Response>; alarm(): Promise<void>; migrate(): Promise<void> };
export interface QuotaLimits {
  bytes: number;
}
export function quotaLimits(env: Record<string, string | undefined>): QuotaLimits;
export function createQuotaService(options: { storage: Storage; limits: QuotaLimits }): PageQuota & {
  available(id: string): number;
  reserve(id: string, operation: string, bytes: number): boolean;
  commit(id: string, operation: string): boolean;
  abort(id: string, operation: string): void;
  release(id: string): void;
  importPage(id: string, bytes: number): void;
  finishMigration(): void;
};
export function routeRequest(
  request: Request,
  env: {
    ALLOW_LOCALHOST?: string;
    PUBLIC_ORIGIN?: string;
    previewImage?: ArrayBuffer;
    page(id: string, request: Request, ip: string): Promise<Response>;
  },
): Promise<Response>;
