import { useEffect, useState } from "react";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { downloadAttachment } from "@milagre/shared/attachment-download";
import { rewriteAssetUrls } from "@milagre/shared/artifact-assets";
import type { ArtifactAsset, ArtifactAssetChunk } from "@milagre/shared/artifact";

const folder = () => new Directory(Paths.cache, "artifact-files");
const cached = (asset: ArtifactAsset) => {
  const file = new File(folder(), asset.hash);
  return file.exists && file.size === asset.size;
};

type Caller = { call<T>(method: string, args: unknown[]): Promise<T> };
export type PageFiles = { uris: Map<string, string> | null; received: number; total: number; error: string };

export function usePageFiles(source: Caller | null, chatId: string | undefined, assets: ArtifactAsset[] | undefined): PageFiles {
  const key = (assets ?? []).map((asset) => `${asset.name}:${asset.hash}`).join("\n");
  const total = (assets ?? []).reduce((sum, asset) => sum + asset.size, 0);
  const [state, setState] = useState<PageFiles & { key: string }>({ key: "", uris: null, received: 0, total: 0, error: "" });
  useEffect(() => {
    const list = assets ?? [];
    let live = true;
    const ready = () => new Map(list.map((asset) => [asset.name, new File(folder(), asset.hash).uri]));
    if (!list.length || list.every(cached)) {
      setState({ key, uris: list.length ? ready() : new Map(), received: total, total, error: "" });
      return;
    }
    setState({ key, uris: null, received: 0, total, error: "" });
    void (async () => {
      try {
        const directory = folder();
        if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
        let received = 0;
        for (const asset of [...list].sort((a, b) => a.size - b.size)) {
          if (!cached(asset)) {
            if (!source || !chatId) throw new Error("Reconnect to this computer to load the page's files.");
            const part = new File(directory, `${asset.hash}.${Date.now().toString(36)}.part`);
            part.create();
            const handle = part.open(FileMode.WriteOnly);
            try {
              await downloadAttachment(
                async (offset) => {
                  const chunk = await source.call<ArtifactAssetChunk>("artifact:asset", [{ chatId, name: asset.name, offset }]);
                  if (chunk?.hash !== asset.hash) throw new Error("The page changed while its files were loading. Open it again.");
                  return { base64: chunk.base64, size: chunk.size, version: chunk.hash };
                },
                (bytes) => handle.writeBytes(bytes),
                (done) => live && setState((current) => ({ ...current, received: received + done })),
              );
            } finally {
              handle.close();
            }
            try {
              part.move(new File(directory, asset.hash));
            } catch (error) {
              part.delete();
              if (!cached(asset)) throw error;
            }
          }
          received += asset.size;
          if (live) setState((current) => ({ ...current, received }));
        }
        if (live) setState({ key, uris: ready(), received: total, total, error: "" });
      } catch (error) {
        if (live) setState({ key, uris: null, received: 0, total, error: error instanceof Error ? error.message : "Could not load the page's files." });
      }
    })();
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [source, chatId, key]);
  return state.key === key ? state : { uris: null, received: 0, total, error: "" };
}

export function pageWithFiles(html: string, assets: ArtifactAsset[] | undefined, uris: Map<string, string>) {
  return rewriteAssetUrls(html, assets, (asset) => uris.get(asset.name) ?? `assets/${asset.name}`);
}
