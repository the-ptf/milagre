const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function externalUrl(url) {
  try {
    const parsed = new URL(url);
    return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function isAppUrl(url, appUrl) {
  try {
    const target = new URL(url);
    const app = new URL(appUrl);
    return app.protocol === "file:" ? target.protocol === "file:" && target.pathname === app.pathname : target.origin === app.origin;
  } catch {
    return false;
  }
}

function guardNavigation(webContents, { appUrl, openExternal }) {
  const leave = (url) => {
    const target = externalUrl(url);
    if (target) openExternal(target);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    leave(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url, appUrl)) return;
    event.preventDefault();
    leave(url);
  });
  webContents.on("will-frame-navigate", (event) => {
    if (/^milagre-artifact:\/\/preview\/[a-f0-9]{48}$/.test(event.url)) return;
    if (event.isMainFrame || isAppUrl(event.url, appUrl) || /^about:(srcdoc|blank)$/.test(event.url)) return;
    event.preventDefault();
  });
}

module.exports = { externalUrl, guardNavigation };
