// One actual Node daemon-client command for the in-process shared-content integration tests.
const { connect } = require("../../../apps/daemon/src/client.cjs");
(async () => {
  const [dataDir, project, method, argument] = process.argv.slice(2);
  const client = await connect({ dataDir, timeoutMs: 10000 });
  try {
    await client.call("project:open", [project]);
    console.log(JSON.stringify({ result: (await client.call(method, JSON.parse(argument))) ?? null }));
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.code, message: error.message } }));
  } finally {
    client.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
