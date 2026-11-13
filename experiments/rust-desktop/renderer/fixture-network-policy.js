// Additive fixture policy, installed before the production module can create
// content. Custom-scheme response headers are not our WebKit enforcement proof.
void (() => {
  if (window !== window.top) return;
  const install = () => {
    if (!document.head) return false;
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content =
      "img-src 'self' data: blob: milagre-artifact:; media-src 'self' data: blob: milagre-artifact:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' milagre-artifact:";
    meta.dataset.fixtureNetworkPolicy = "true";
    document.head.prepend(meta);
    return true;
  };
  if (install()) return;
  const observer = new MutationObserver(() => {
    if (install()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
})();
