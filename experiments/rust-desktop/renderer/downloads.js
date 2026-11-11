// WKWebView does not provide Electron's download manager for blob: links. Keep
// the production export components unchanged and bridge their download anchors.
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export async function downloadPayload(blob, name) {
  if (!(blob instanceof Blob)) throw new Error("This download is no longer available. Export it again.");
  if (blob.size > MAX_DOWNLOAD_BYTES) throw new Error("Downloads larger than 64 MiB are not supported in this Rust build.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return { name: name || "download", size: bytes.length, base64: btoa(chunks.join("")) };
}

export function installDownloads(invoke, onError) {
  const blobs = new Map();
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = function (blob) {
    const url = createObjectURL.call(this, blob);
    if (blob instanceof Blob) blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(String(url));
    return revokeObjectURL.call(this, url);
  };
  const save = (anchor) => {
    // Capture the Blob synchronously before the production component revokes its
    // URL. Native saving may outlive the renderer's one-second export URL timeout.
    const blob = blobs.get(anchor.href);
    const name = anchor.download;
    void downloadPayload(blob, name)
      .then((payload) => invoke("download:save", payload))
      .catch(onError);
  };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    // DesignExportDialog intentionally clicks a detached anchor, so document
    // listeners alone cannot intercept the download before the navigation guard.
    if (this.hasAttribute("download")) {
      save(this);
      return;
    }
    return click.call(this);
  };
  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[download]") : null;
    if (!anchor || event.defaultPrevented) return;
    event.preventDefault();
    save(anchor);
  });
}
