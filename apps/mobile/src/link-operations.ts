export function createLinkOperations() {
  const pending = new Map<string, { signature: string; id: string }>();
  return {
    forSend(key: string, signature: string, makeId: () => string) {
      const previous = pending.get(key);
      if (previous?.signature === signature) return previous.id;
      const id = makeId();
      pending.set(key, { signature, id });
      return id;
    },
    accepted(key: string, id: string) {
      if (pending.get(key)?.id === id) pending.delete(key);
    },
  };
}
