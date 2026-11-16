// What iOS reports for every device when the app may not read the name its owner chose (iOS 16 and later without the
// user-assigned-device-name entitlement, which would need a new native build).
const GENERIC = new Set(["iPhone", "iPad", "iPod touch"]);
const MAX_NAME = 64;

export function phoneNameFrom(deviceName: string | null | undefined, modelName: string | null | undefined): string | null {
  const own = deviceName?.trim() || null;
  const model = modelName?.trim() || null;
  const name = own && !GENERIC.has(own) ? own : (model ?? own);
  return name ? Array.from(name).slice(0, MAX_NAME).join("") : null;
}
