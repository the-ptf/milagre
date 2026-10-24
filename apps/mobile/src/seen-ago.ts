/** "seen 5m ago" from the last time this phone opened the computer; empty when it never has. */
export function seenAgo(lastUsed: number, now = Date.now()): string {
  if (!(lastUsed > 0)) return "";
  const minutes = Math.max(0, Math.round((now - lastUsed) / 60_000));
  if (minutes < 1) return "seen just now";
  if (minutes < 60) return `seen ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `seen ${hours}h ago`;
  return `seen ${Math.round(hours / 24)}d ago`;
}
