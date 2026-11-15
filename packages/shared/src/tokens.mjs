export function formatTokens(tokens) {
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1) return String(Math.round(tokens));
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(tokens / 100_000) / 10}M`;
}
