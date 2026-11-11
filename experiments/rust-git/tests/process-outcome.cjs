// Normalize the Rust runner's actual partial output through the production Node
// boundary. Process behavior itself is exercised by Rust's disposable scripts.
const fs = require("node:fs");
const { createGit } = require("../../../packages/core/src/git/client.cjs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const git = createGit({
  execFile(_command, _args, _options, done) {
    done(Object.assign(new Error("process failure"), input.failure), input.stdout, input.stderr);
  },
});
git.read.run(process.cwd(), ["status"]).then((result) => process.stdout.write(JSON.stringify(result)));
