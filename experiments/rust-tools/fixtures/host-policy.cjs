// Actual Node host guard, no provider, sockets or stored data.
const { EscalationTurn } = require("../../../packages/core/src/escalation-guard.cjs");
let stops = 0;
const guard = new EscalationTurn({ requests: [{ chatId: "/child#2", requestId: "request-1" }] }, () => stops++);
const calls = [];
for (let index = 0; index < 12; index++) {
  guard.called();
  calls.push({ calls: guard.calls, denial: guard.denial({ name: "artifact_list", input: {}, readOnly: true }), stops });
}
process.stdout.write(JSON.stringify({ calls }));
