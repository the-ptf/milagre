const { z } = require("zod");
const { PROVIDERS } = require("@milagre/shared/providers");
const { providerCapabilities } = require("@milagre/shared/provider-capabilities");

/** The providers that can host an advisor. */
const ADVISOR_PROVIDERS = /** @type {[string, ...string[]]} */ (PROVIDERS.filter((provider) => providerCapabilities(provider).advisor));
const title = z.string().trim().min(1).max(120);
const prompt = z.string().trim().min(1).max(40_000);
const createInput = z.strictObject({
  title,
  prompt,
  provider: z.enum(ADVISOR_PROVIDERS).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(40).optional(),
  mode: z.enum(["analysis", "execution"]).optional(),
});
function advisorToolDefinitions(chatId, manager) {
  const tool = (name, description, input, readOnly, run) => ({
    name,
    description,
    input,
    readOnly,
    strict: true,
    run: async (args) => JSON.stringify(await run(args)),
  });
  const id = { advisorId: z.string().startsWith("advisor:").max(100) };
  return [
    tool("advisor_providers", "Discover available advisor providers and their reported models/efforts for this Chat.", {}, true, () =>
      manager.providers(chatId),
    ),
    tool(
      "create_advisor",
      "Start an asynchronous advisor. mode defaults to analysis (read-only); execution runs commands and browser work in this Chat's prepared Worktrees and requires the Chat's Full permissions. Default is the other provider. At most two active advisors per Chat. Completion returns as labeled context.",
      createInput.shape,
      false,
      (args) => manager.create(chatId, args),
    ),
    tool(
      "advisor_followup",
      "Queue a follow-up after the current advisor turn. Preserves history. At most four queued prompts.",
      { ...id, prompt },
      false,
      (args) => manager.followup(chatId, args.advisorId, args.prompt),
    ),
    tool("advisor_read", "Inspect a settled advisor after its completion notice. Returns status, transcript and output; do not poll.", id, true, (args) =>
      manager.read(chatId, args.advisorId),
    ),
    tool("advisor_stop", "Stop an advisor owned by this Chat and discard its queued prompts.", id, false, (args) => manager.stop(chatId, args.advisorId)),
  ];
}
module.exports = { ADVISOR_PROVIDERS, advisorToolDefinitions, createInput, promptInput: prompt };
