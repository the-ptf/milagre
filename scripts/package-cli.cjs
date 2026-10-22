// Package the daemon and its private workspace dependencies as an installable CLI.
// Bundle private workspace sources. npm installs registry dependencies for the target platform.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");
const readPackage = async (directory) => JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));

async function copySource(from, to) {
  await fs.cp(path.join(from, "src"), path.join(to, "src"), {
    recursive: true,
    filter: (file) => !/\.test\.(cjs|mjs|ts)$/.test(file) && !["fixtures", "relay-test-kit.cjs", "large-project-fixture.cjs"].includes(path.basename(file)),
  });
  await fs.copyFile(path.join(from, "package.json"), path.join(to, "package.json"));
}

async function packageCli({ outDir = path.join(root, "release", "cli") } = {}) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-cli-pack-"));
  try {
    const daemonDir = path.join(root, "apps/daemon");
    await copySource(daemonDir, stage);
    const daemon = await readPackage(daemonDir);
    const dependencies = { ...daemon.dependencies };
    const optionalDependencies = {};
    const bundled = [];
    for (const relative of ["packages/core", "packages/shared"]) {
      const from = path.join(root, relative);
      const pkg = await readPackage(from);
      for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
        if (dependencies[name] && dependencies[name] !== range) throw new Error(`Conflicting CLI dependency: ${name}`);
        dependencies[name] = range;
      }
      Object.assign(optionalDependencies, pkg.optionalDependencies);
      bundled.push(pkg.name);
      const target = path.join(stage, "node_modules", pkg.name);
      await copySource(from, target);
      // The CLI owns the entire dependency graph. Keeping these edges on the bundled packages makes npm
      // treat their registry dependencies as bundled too, skipping target-specific optional binaries.
      const {
        dependencies: _dependencies,
        optionalDependencies: _optional,
        peerDependencies: _peers,
        devDependencies: _dev,
        scripts: _scripts,
        ...vendored
      } = pkg;
      await fs.writeFile(path.join(target, "package.json"), JSON.stringify(vendored, null, 2) + "\n");
    }
    const manifest = {
      name: "milagre",
      version: daemon.cliVersion ?? daemon.version,
      description: "Run Milagre agents on a computer without a desktop UI",
      license: "MIT",
      repository: { type: "git", url: "https://github.com/the-ptf/milagre-ade.git", directory: "apps/daemon" },
      type: "commonjs",
      bin: daemon.bin,
      engines: daemon.engines,
      files: ["src", "prepare-node-pty.cjs"],
      scripts: { postinstall: "node prepare-node-pty.cjs" },
      dependencies,
      optionalDependencies,
      bundleDependencies: bundled,
    };
    await fs.writeFile(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    // Resolve node-pty from the bundled core here as well as from the source checkout.
    await fs.copyFile(path.join(root, "scripts/prepare-node-pty.cjs"), path.join(stage, "prepare-node-pty.cjs"));
    await fs.copyFile(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
    await fs.copyFile(path.join(daemonDir, "README.md"), path.join(stage, "README.md"));
    await fs.chmod(path.join(stage, "src/command.cjs"), 0o755);
    outDir = path.resolve(outDir);
    await fs.mkdir(outDir, { recursive: true });
    const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", outDir], {
      cwd: stage,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    const [packed] = JSON.parse(stdout);
    if (!bundled.every((name) => packed.bundled.includes(name))) throw new Error("The CLI package is missing a workspace dependency");
    return path.join(outDir, packed.filename);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

module.exports = { packageCli };
if (require.main === module)
  packageCli()
    .then((archive) => console.log(archive))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
