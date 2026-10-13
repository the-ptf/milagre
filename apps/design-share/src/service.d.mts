export const MAX_BODY_BYTES: number;
export const MAX_HTML_BYTES: number;
export const CHUNK_BYTES: number;
export const PAGE_ID: RegExp;
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
export function createPageService<Snapshot>(options: {
  storage: Storage;
  validate(value: unknown): Snapshot;
  render(snapshot: Snapshot): string;
  admit(ip: string): Promise<boolean>;
  reserve(ip: string, bytes: number): Promise<boolean>;
}): { fetch(request: Request, id: string, ip: string): Promise<Response> };
export interface QuotaLimits {
  bytes: number;
  pages: number;
  daily: number;
  perIp: number;
}
export function quotaLimits(env: Record<string, string | undefined>): QuotaLimits;
export function createQuotaService(options: { storage: Storage; limits: QuotaLimits; now?: () => number }): {
  admit(ip: string): Promise<boolean>;
  reserve(ip: string, bytes: number): Promise<boolean>;
};
export function routeRequest(
  request: Request,
  env: {
    ALLOW_LOCALHOST?: string;
    PUBLIC_ORIGIN?: string;
    page(id: string, request: Request, ip: string): Promise<Response>;
  },
): Promise<Response>;
