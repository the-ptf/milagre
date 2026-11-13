// Routes Browser panel close requests from this host and from paired computers back to the renderer that owns the tabs.
function routeBrowserPanelClose(channel, payload, { closePage, closeAll, qualifyKey }) {
  if (channel === "browser-panel:close-page" && typeof payload?.chatId === "string" && typeof payload.pageId === "string") {
    closePage(payload.chatId, payload.pageId);
    return true;
  }
  if (channel === "browser-panel:close-chat-pages" && typeof payload?.chatId === "string") {
    closeAll(payload.chatId);
    return true;
  }
  if (channel !== "computers:event" || typeof payload?.computerId !== "string") return false;
  const remote = payload.payload;
  const chatKey = typeof remote?.chatId === "string" ? qualifyKey(payload.computerId, remote.chatId) : null;
  if (!chatKey) return false;
  if (payload.channel === "browser-panel:close-page" && typeof remote.pageId === "string") {
    closePage(chatKey, remote.pageId);
    return true;
  }
  if (payload.channel === "browser-panel:close-chat-pages") {
    closeAll(chatKey);
    return true;
  }
  return false;
}

module.exports = { routeBrowserPanelClose };
