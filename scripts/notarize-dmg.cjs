const { spawnSync } = require("node:child_process");

const file = process.argv[2];
const credentials = ["--apple-id", process.env.APPLE_ID, "--password", process.env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", process.env.APPLE_TEAM_ID];
const transient =
  /NSURLErrorDomain[^\n]*Code=-(?:1001|1003|1004|1005|1006|1009)\b|No network route|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Network\.NWError error (?:50|60)\b|HTTP(?: status code:|Error\(statusCode:)\s*(?:Optional\()?5\d\d/i;

function request(operation, args) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = spawnSync("xcrun", args, { encoding: "utf8" });
    if (result.status === 0) return result.stdout;
    if (result.signal) throw new Error(`Apple ${operation} was interrupted.`);
    const output = (result.stderr || "") + (result.stdout || "");
    if (/HTTP(?: status code:|Error\(statusCode:)\s*(?:Optional\()?401\b|Invalid credentials/i.test(output))
      throw new Error("Apple rejected the notarization credentials (HTTP 401).");
    if (attempt === 4 || !transient.test(output)) {
      throw new Error(`Apple ${operation} failed${transient.test(output) ? " after four network attempts" : ""}.`);
    }
    console.warn(`Temporary network failure during Apple ${operation}; retrying (${attempt}/3).`);
    const delay = spawnSync("sleep", [String(attempt * 10)], { stdio: "ignore" });
    if (delay.status !== 0) throw new Error("Notarization retry was interrupted.");
  }
}

try {
  if (!file || credentials.some((value) => !value)) throw new Error("A disk image and Apple credentials are required.");
  const submission = JSON.parse(request("submission", ["notarytool", "submit", file, ...credentials, "--output-format", "json"]));
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(submission.id || "")) throw new Error("Apple did not return a valid submission ID.");
  console.log(`Waiting for Apple submission ${submission.id}.`);
  const result = JSON.parse(request("wait", ["notarytool", "wait", submission.id, ...credentials, "--output-format", "json"]));
  if (result.id !== submission.id) throw new Error("Apple returned an unexpected submission ID.");
  if (result.status !== "Accepted") {
    const status = ["Invalid", "Rejected", "In Progress"].includes(result.status) ? result.status : "unexpected status";
    throw new Error(`Apple notarization failed: ${status} (submission ${submission.id})`);
  }
  request("stapling", ["stapler", "staple", file]);
  console.log(`Apple accepted and stapled ${file}.`);
} catch (error) {
  console.error(error instanceof SyntaxError ? "Apple returned invalid notarization JSON." : error.message);
  process.exit(1);
}
