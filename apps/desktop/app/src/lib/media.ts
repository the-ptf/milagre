export function mediaKind(path: string): "image" | "video" | null {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (ext && ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"].includes(ext)) return "image";
  if (ext && ["mp4", "mov", "webm", "m4v", "ogv"].includes(ext)) return "video";
  return null;
}
export function mediaUrl(path: string): string {
  return `milagre-media://file/?path=${encodeURIComponent(path)}`;
}
export function attachmentPrompt(body: string, files: string[]): string {
  if (!files.length) return body || "Describe the attached images.";
  return `${body || "Please review the attached files."}\n\nAttached files:\n${files.join("\n")}`;
}

export const canCopyImage = (file: string | undefined): file is string =>
  !!file && (!file.startsWith("data:") || /^data:image\/(png|jpeg|webp|gif);base64,/.test(file));
