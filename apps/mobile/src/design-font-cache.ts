import { createDesignFontReader, type Artifact } from "@milagre/shared/artifact";
import type { Client } from "./client";

type Source = Pick<Client, "call">;
const readers = new WeakMap<Source, ReturnType<typeof createDesignFontReader<Artifact>>>();
const generations = new WeakMap<Source, number>();

/** A connection owns its font cache. Reopening the sheet reuses it; another Computer never does. */
export function loadCanvasDesign(source: Source, request: { chatId: string; id: string; version?: number }, generation = 0): Promise<Artifact> {
  let read = readers.get(source);
  if (!read) {
    read = createDesignFontReader((args) => source.call<Artifact>("artifact:get", [args]));
    readers.set(source, read);
  }
  if (generations.get(source) !== generation) {
    read.reconnect();
    generations.set(source, generation);
  }
  return read(request);
}
