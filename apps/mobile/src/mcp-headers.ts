import { MCP_SECRET_MASK } from "@milagre/shared/mcp";

export type McpHeaderRow = { id: number; key: string; value: string; masked: boolean; needsValue?: boolean };

export function mcpHeadersPayload(rows: McpHeaderRow[]): { headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value && !row.masked) continue;
    if (row.needsValue && !row.value) return { error: `Enter a value for ${key || "the renamed header"}.` };
    headers[key] = row.masked ? MCP_SECRET_MASK : row.value;
  }
  return { headers };
}

export function renameHeader(row: McpHeaderRow, key: string): McpHeaderRow {
  return row.masked ? { ...row, key, masked: false, value: "", needsValue: true } : { ...row, key };
}
