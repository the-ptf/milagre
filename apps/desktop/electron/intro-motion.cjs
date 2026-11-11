// @ts-check

/**
 * Observe GPU initialization before app.whenReady(), but query it only when a first-launch window is about to open.
 * @param {{ app: Pick<import("electron").App, "once" | "getGPUInfo" | "getGPUFeatureStatus" | "commandLine">, platform: NodeJS.Platform, timeoutMs?: number }} options
 */
function createIntroMotionDecision({ app, platform, timeoutMs = 1500 }) {
  const gpuReady = new Promise((resolve) => app.once("gpu-info-update", () => resolve(undefined)));
  return async function simpleIntro(/** @type {boolean} */ openedProjectsBefore) {
    if (openedProjectsBefore) return false;
    if (app.commandLine.hasSwitch("disable-gpu")) return true;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {Promise<boolean>} */
    const timedOut = new Promise((resolve) => {
      // Headless Linux commonly lacks a GPU. Keep the animated scene on GPU Macs/Windows if the probe stalls.
      timer = setTimeout(() => resolve(platform === "linux"), timeoutMs);
    });
    try {
      return await Promise.race([
        gpuReady
          .then(() => app.getGPUInfo("basic"))
          .then(
            (info) =>
              /** @type {{ auxAttributes?: { softwareRendering?: boolean } }} */ (info).auxAttributes?.softwareRendering === true ||
              !app.getGPUFeatureStatus().gpu_compositing?.startsWith("enabled"),
          )
          .catch(() => true),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createIntroMotionDecision };
