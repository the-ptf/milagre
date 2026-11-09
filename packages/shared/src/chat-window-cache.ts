type Message = { role?: string };
type ChatWindow = { messages: Message[]; hasMore: boolean };

/** Prepend only adjacent history. Leaving a Chat can trim/evict its window while the request is in flight. */
export function prependChatPage<T extends { messages: { id: number }[]; hasMore: boolean }>(
  current: T | undefined,
  before: number,
  earlier: Pick<T, "messages" | "hasMore">,
): T | undefined {
  if (!current || current.messages[0]?.id !== before) return current;
  const known = new Set(current.messages.map((message) => message.id));
  return { ...current, messages: [...earlier.messages.filter((message) => !known.has(message.id)), ...current.messages], hasMore: earlier.hasMore };
}

/** Recent Chat pages. Active readers own their full history; inactive pages have a bounded payload and turn count. */
export class ChatWindowCache<T extends ChatWindow> {
  private readonly windows = new Map<string, T>();
  private readonly readers = new Map<string, number>();
  private readonly sizes = new WeakMap<Message, number>();
  private readonly options: { maxChats: number; maxBytes: number; turns: number };

  constructor(options: { maxChats: number; maxBytes: number; turns: number }) {
    this.options = options;
  }

  get(key: string) {
    return this.windows.get(key);
  }
  has(key: string) {
    return this.windows.has(key);
  }
  keys() {
    return this.windows.keys();
  }
  [Symbol.iterator]() {
    return this.windows[Symbol.iterator]();
  }

  retain(key: string) {
    this.readers.set(key, (this.readers.get(key) ?? 0) + 1);
    const current = this.windows.get(key);
    if (current) {
      this.windows.delete(key);
      this.windows.set(key, current);
    }
  }

  release(key: string) {
    const count = this.readers.get(key) ?? 0;
    if (count === 0) return;
    this.readers.set(key, count - 1);
    if (count > 1) return;
    // React cleans up the tile subscription before subscribing the focused Chat in the same commit.
    // Keep the window protected through that handoff, including writes/pruning by other Chats.
    queueMicrotask(() => {
      if (this.readers.get(key) !== 0) return;
      this.readers.delete(key);
      const current = this.windows.get(key);
      if (current) this.windows.set(key, this.tail(current));
      this.prune();
    });
  }

  set(key: string, value: T) {
    this.windows.delete(key);
    this.windows.set(key, this.readers.has(key) ? value : this.tail(value));
    this.prune();
  }

  /**
   * A read window back to its last turns once it holds more than twice as many: a Chat open for hours, followed at its
   * bottom, keeps every message since it opened otherwise. The trimmed window, or null when nothing changed.
   */
  trim(key: string): T | null {
    const current = this.windows.get(key);
    if (!current) return null;
    let turns = 0;
    for (const message of current.messages) if (message.role === "user") turns++;
    if (turns <= this.options.turns * 2) return null;
    const next = this.tail(current);
    if (next === current) return null;
    this.windows.set(key, next);
    return next;
  }

  private tail(value: T): T {
    let turns = 0;
    for (let i = value.messages.length - 1; i >= 0; i--) {
      if (value.messages[i]!.role === "user" && ++turns === this.options.turns) {
        return i === 0 ? value : { ...value, messages: value.messages.slice(i), hasMore: true };
      }
    }
    return value;
  }

  private bytes(value: T) {
    let bytes = 0;
    for (const message of value.messages) {
      let size = this.sizes.get(message);
      if (size === undefined) {
        // Conservative UTF-16 serialized payload estimate, not a whole-heap measurement. Immutable messages are
        // measured once; the WeakMap does not keep evicted messages or previous streaming versions alive.
        size = JSON.stringify(message).length * 2;
        this.sizes.set(message, size);
      }
      bytes += size;
    }
    return bytes;
  }

  private prune() {
    const inactive = [...this.windows].filter(([key]) => !this.readers.has(key));
    let bytes = inactive.reduce((sum, [, value]) => sum + this.bytes(value), 0);
    for (const [key, value] of inactive) {
      if (this.windows.size <= this.options.maxChats && bytes <= this.options.maxBytes) break;
      this.windows.delete(key);
      bytes -= this.bytes(value);
    }
  }
}
