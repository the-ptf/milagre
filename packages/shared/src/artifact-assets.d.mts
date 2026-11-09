/** One file of an Artifact page, as the page keeps it. */
export type ArtifactAsset = { name: string; hash: string; size: number; type: string };

export const ASSET_NAME: RegExp;
export const ASSET_HASH: RegExp;
export const MAX_ASSET_BYTES: number;
export const MAX_PAGE_ASSETS: number;
export const MAX_PAGE_ASSET_BYTES: number;
export function assetType(name: string): string;
export function assetInline(type: string): boolean;
export function mentionsAsset(html: string, name: string): boolean;
export function rewriteAssetUrls<T extends { name: string }>(html: string, assets: readonly T[] | undefined, urlFor: (asset: T) => string): string;
/** One `bytes=` range of a file of `size` bytes, as an offset and a length; null for the whole file. */
export function byteRange(header: string | null | undefined, size: number): { offset: number; length: number } | null | "unsatisfiable";
