const key = (id) => `page:${id}`;
const held = (page) => Math.max(page?.bytes ?? 0, page?.pending?.bytes ?? 0);
const valid = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

/** Active allocations, not a lifetime counter. Each page holds its previous charge until
 * its new revision commits. Operations and releases are idempotent across lost replies. */
export function createQuotaService({ storage, limits }) {
  const change = (id, page) => {
    const previous = storage.get(key(id));
    const total = storage.get("activeBytes") ?? 0;
    storage.put("activeBytes", total + held(page) - held(previous));
    storage.put(key(id), page);
  };
  const ready = () => storage.get("migrated") === true || !storage.get("total");
  return {
    available(id) {
      if (!valid(id) || !ready()) return 0;
      const page = storage.get(key(id));
      return page?.closed ? 0 : Math.max(0, limits.bytes - (storage.get("activeBytes") ?? 0) + held(page));
    },
    // A page whose only files were removed before it was ever published settles at 0 bytes.
    reserve(id, operation, bytes) {
      if (!valid(id) || !Number.isSafeInteger(Number(operation)) || Number(operation) < 1 || !Number.isSafeInteger(bytes) || bytes < 0 || !ready())
        return false;
      return storage.transaction(() => {
        const page = storage.get(key(id)) ?? { bytes: 0 };
        if (page.closed) return false;
        if (page.pending) return page.pending.operation === operation && page.pending.bytes === bytes;
        if (Number(operation) <= Number(page.operation ?? 0)) return page.operation === operation && !page.aborted && page.bytes === bytes;
        const pending = { operation, bytes };
        if ((storage.get("activeBytes") ?? 0) + Math.max(0, bytes - page.bytes) > limits.bytes) return false;
        change(id, { ...page, pending });
        return true;
      });
    },
    commit(id, operation) {
      return storage.transaction(() => {
        const page = storage.get(key(id));
        if (page?.closed) return false;
        if (page?.operation === operation) return !page.aborted;
        if (page?.pending?.operation !== operation) return false;
        change(id, { bytes: page.pending.bytes, operation });
        return true;
      });
    },
    abort(id, operation) {
      storage.transaction(() => {
        const page = storage.get(key(id));
        if (page?.pending?.operation === operation) {
          const { pending: _pending, ...previous } = page;
          change(id, { ...previous, operation, aborted: true });
        } else if (!page?.closed && !page?.pending && Number(operation) > Number(page?.operation ?? 0)) {
          change(id, { ...page, bytes: page?.bytes ?? 0, operation, aborted: true });
        }
      });
    },
    release(id) {
      if (!valid(id)) throw Error("Invalid page id");
      storage.transaction(() => change(id, { bytes: 0, closed: true }));
    },
    // Old counters cannot reconstruct live allocations: old source JSON was discarded.
    // Before enabling uploads, inventory legacy objects and charge their remaining HTML.
    importPage(id, bytes) {
      if (!valid(id) || !Number.isSafeInteger(bytes) || bytes < 0) throw Error("Invalid legacy page");
      storage.transaction(() => {
        if (!storage.get(key(id))) change(id, { bytes });
      });
    },
    finishMigration() {
      storage.put("migrated", true);
    },
  };
}

export function quotaLimits(env) {
  const bytes = env.MAX_TOTAL_BYTES === undefined ? 20 * 1024 ** 3 : Number(env.MAX_TOTAL_BYTES);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw Error("Invalid MAX_TOTAL_BYTES");
  return { bytes };
}
