const { z } = require("zod");

// Browsers join a Chat by process lineage (see docs/adr/0016-browser-page-ownership.md) or by an explicit attach.
// These tools let the agent attach the browser it drives when lineage cannot see it, bound to its own Chat.
const browserId = z.string().min(8).max(64).describe("A browser id from browser_list: an entry under others, or the part of a page id before the colon.");
function browserToolDefinitions(chatId, api) {
  return [
    {
      name: "browser_list",
      description:
        "List browser pages in this Chat (browsers its agent started, or attached ones) and other browsers on this computer available to attach. Listing never starts a capture.",
      input: {},
      readOnly: true,
      run: async () => JSON.stringify(await api.list({ chatId })),
    },
    {
      name: "browser_attach",
      description:
        "Attach a browser on this computer to this Chat so the user can view and control its pages from desktop or phone. Use the id of an entry under others from browser_list. Browsers this Chat's agent started are already in the Chat.",
      input: { browserId },
      readOnly: false,
      run: async (input) =>
        JSON.stringify({
          ...(await api.attach({ chatId, browserId: input.browserId })),
          guidance:
            "This browser is attached to the current Chat. Keep driving it with your own automation tools; keep it attached for the user to inspect. browser_detach removes only this Chat association and leaves the browser running.",
        }),
    },
    {
      name: "browser_detach",
      description:
        "Remove an attached browser from this Chat and close this Chat's viewers of its pages. Leaves the browser running and other Chats' attachments intact. Browsers this Chat's agent started cannot be detached.",
      input: { browserId },
      readOnly: false,
      run: async (input) => JSON.stringify(await api.detach({ chatId, browserId: input.browserId })),
    },
  ];
}
module.exports = { browserToolDefinitions };
