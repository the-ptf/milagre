export const PAGE_TTL_MS: number;
export const CHUNK_BYTES: number;
export const SECURITY_HEADERS: Record<string, string>;
export function response(body: BodyInit | null, status?: number, type?: string, headers?: Record<string, string>): Response;
export function fileKey(id: string, hash: string): string;
/** The bucket that keeps Artifact pages' files (R2 in production). */
export interface FileBucket {
  head(key: string): Promise<{ size: number; type: string; etag?: string } | null>;
  get(key: string, range?: { offset: number; length: number }): Promise<{ body: ReadableStream | null } | null>;
  put(key: string, body: ReadableStream | null, options: { size: number; sha256: string; type: string }): Promise<void>;
  delete(keys: string[]): Promise<void>;
}
export function serveFile(bucket: FileBucket, key: string, request: Request): Promise<Response>;
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
  render(snapshot: Snapshot, options: { files: (asset: { hash: string }) => string }): string;
  quota: PageQuota;
  quotaId: string;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  bucket?: FileBucket | null;
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
    file?(id: string, hash: string, request: Request): Promise<Response>;
  },
): Promise<Response>;
