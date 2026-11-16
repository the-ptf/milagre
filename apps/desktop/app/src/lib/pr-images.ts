import { githubImageSource } from "@milagre/shared/github-image";
import type { MarkdownImageLoader } from "../components/markdown/Markdown";
import type { MilagreBridge } from "../electron";

const MAX_KEPT = 64;
const kept = new Map<string, Promise<string>>();

export function prImageLoader(bridge: MilagreBridge["pr"], cwd: string): MarkdownImageLoader {
  return (src) => {
    if (!githubImageSource(src)) return null;
    const key = `${cwd}\0${src}`;
    const hit = kept.get(key);
    if (hit) {
      kept.delete(key);
      kept.set(key, hit);
      return hit;
    }
    const read = bridge.image({ cwd, url: src }).then((result) => {
      if (!result.ok) throw new Error(result.message);
      return result.dataUrl;
    });
    read.catch(() => kept.get(key) === read && kept.delete(key));
    kept.set(key, read);
    for (const oldest of kept.keys()) {
      if (kept.size <= MAX_KEPT) break;
      kept.delete(oldest);
    }
    return read;
  };
}
