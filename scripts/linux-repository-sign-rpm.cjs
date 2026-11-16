const path = require("node:path");
const { signRPM } = require("./generate-linux-repository.cjs");

try {
  if (process.argv.length !== 4 || process.argv[2] !== "--rpm")
    throw new Error("Usage: node scripts/linux-repository-sign-rpm.cjs --rpm /path/to/Milagre-X.Y.Z-x86_64.rpm");
  const rpm = path.resolve(process.argv[3]);
  signRPM(rpm);
  console.log(`Signed and verified ${path.basename(rpm)}. Generate checksums from these final bytes.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
