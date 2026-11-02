export const CONTEXT_DEFAULTS = Object.freeze({ buttonThreshold: 70, autoThreshold: 85, autoCompact: false });
export const CONTEXT_GRADIENT_COLORS = ["#78b1b1", "#e0c271", "#f1933e", "#cf4e3e"];
export const CONTEXT_GRADIENT_STOPS = [0, 0.55, 0.78, 1];
export const CONTEXT_GRADIENT = "linear-gradient(90deg, #78b1b1 0%, #e0c271 55%, #f1933e 78%, #cf4e3e 100%)";
const percent = (value, fallback, min, max) => Math.max(min, Math.min(max, typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback));
export function normalizeContextSettings(value) {
  const buttonThreshold = percent(value?.buttonThreshold, 70, 5, 90);
  return { buttonThreshold, autoThreshold: percent(value?.autoThreshold, 85, buttonThreshold + 5, 95), autoCompact: value?.autoCompact === true };
}
export function shouldAutoCompact(settings, usage) {
  return (
    settings.autoCompact &&
    Number.isFinite(usage?.used) &&
    Number.isFinite(usage?.size) &&
    usage.size > 0 &&
    (usage.used / usage.size) * 100 >= settings.autoThreshold
  );
}
