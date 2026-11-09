import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAPABILITIES, providerCapabilities } from "./provider-capabilities.mjs";
import { PROVIDERS } from "./providers.mjs";

const FLAGS = Object.keys(DEFAULT_CAPABILITIES).toSorted();

test("every known provider declares every flag as a boolean, frozen", () => {
  for (const provider of PROVIDERS) {
    const capabilities = providerCapabilities(provider);
    assert.deepEqual(Object.keys(capabilities).toSorted(), FLAGS, provider);
    for (const flag of FLAGS) assert.equal(typeof capabilities[flag], "boolean", `${provider}.${flag}`);
    assert.ok(Object.isFrozen(capabilities), provider);
  }
});

test("an unknown provider gets the conservative defaults", () => {
  for (const provider of ["gemini", "", undefined, null, "toString", "__proto__"]) assert.equal(providerCapabilities(provider), DEFAULT_CAPABILITIES);
  assert.ok(Object.isFrozen(DEFAULT_CAPABILITIES));
  for (const flag of FLAGS) assert.equal(DEFAULT_CAPABILITIES[flag], false, flag);
});

test("the flags match what each provider's agent does", () => {
  assert.deepEqual(Object.fromEntries(PROVIDERS.map((provider) => [provider, providerCapabilities(provider)])), {
    codex: { steer: true, compact: false, backgroundSubagents: false, subagentRecovery: true, advisor: true, managedInstall: false, addAccounts: true },
    claude: { steer: true, compact: true, backgroundSubagents: true, subagentRecovery: false, advisor: true, managedInstall: false, addAccounts: true },
    antigravity: { steer: false, compact: false, backgroundSubagents: false, subagentRecovery: true, advisor: false, managedInstall: true, addAccounts: true },
    kiro: { steer: false, compact: false, backgroundSubagents: false, subagentRecovery: false, advisor: false, managedInstall: false, addAccounts: false },
  });
});
