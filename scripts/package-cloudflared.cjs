const fs = require("node:fs/promises");
const path = require("node:path");
const { installCloudflared, artifactFor } = require("../apps/daemon/src/cloudflared.cjs");
module.exports = async function packageCloudflared(context, options = {}) {
  const platform = context.electronPlatformName;
  const arch = { 0: "ia32", 1: "x64", 2: "arm", 3: "arm64", 4: "universal" }[context.arch];
  const resources =
    platform === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const bin = path.join(resources, "bin");
  await fs.mkdir(bin, { recursive: true, mode: 0o755 });
  const binary = path.join(bin, platform === "win32" ? "cloudflared.exe" : "cloudflared");
  await installCloudflared({ target: binary, artifact: options.artifact ?? artifactFor(platform, arch), download: options.download });
  await fs.chmod(binary, 0o755);
  await fs.copyFile(path.join(__dirname, "../licenses/cloudflared-LICENSE.txt"), path.join(bin, "cloudflared-LICENSE.txt"));
};
