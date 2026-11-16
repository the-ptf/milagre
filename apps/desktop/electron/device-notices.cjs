// @ts-check
const TAKE = "devices:take-notices";
const CONFIRM = "devices:confirm-notices";

/**
 * @param {{
 *   methods: () => readonly string[] | null | undefined;
 *   invoke: (method: string, args: unknown[]) => Promise<unknown>;
 *   notifyPhones: (phones: Array<{ name: string | null }>, options: { away: boolean }) => unknown;
 *   notifyDevice: (kind: string | undefined) => unknown;
 * }} options
 */
function createDeviceNotices({ methods, invoke, notifyPhones, notifyDevice }) {
  /** @param {boolean} away */
  async function take(away) {
    /** @type {any} */
    let taken;
    try {
      taken = await invoke(TAKE, []);
    } catch {
      return;
    }
    const phones = (Array.isArray(taken?.devices) ? taken.devices : [])
      .filter((/** @type {any} */ device) => device && device.kind === "phone")
      .map((/** @type {any} */ device) => ({ name: typeof device.name === "string" ? device.name : null }));
    if (phones.length) notifyPhones(phones, { away });
    if (typeof taken?.claim !== "string") return;
    try {
      await invoke(CONFIRM, [taken.claim]);
    } catch {}
  }
  return {
    connected() {
      if (methods()?.includes(TAKE)) return take(true);
      return Promise.resolve();
    },
    /** @param {{ kind?: string } | undefined} payload */
    paired(payload) {
      const known = methods();
      if (!known) return Promise.resolve();
      if (known.includes(TAKE)) return take(false);
      if (payload?.kind !== "computer") notifyDevice(payload?.kind);
      return Promise.resolve();
    },
  };
}

module.exports = { createDeviceNotices };
