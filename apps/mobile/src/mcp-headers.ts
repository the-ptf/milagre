import { MCP_SECRET_MASK } from "@milagre/shared/mcp";

/** One header in the add sheet. `masked`: the Mac sent its value as the mask and the field has not been typed in. */
export type McpHeaderRow = { id: number; key: string; value: string; masked: boolean; needsValue?: boolean };

/** The headers a save sends. A masked row goes back as the mask (the Mac keeps the stored value) even when its field was cleared by focus. */
export function mcpHeadersPayload(rows: McpHeaderRow[]): { headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value && !row.masked) continue;
    // A masked secret under a new name cannot be carried over: the phone never has the real value.
    if (row.needsValue && !row.value) return { error: `Enter a value for ${key || "the renamed header"}.` };
    headers[key] = row.masked ? MCP_SECRET_MASK : row.value;
  }
  return { headers };
}

/** Typing in a masked row's name renames it: its stored value stays on the old name, so the row now needs a new value. */
export function renameHeader(row: McpHeaderRow, key: string): McpHeaderRow {
  return row.masked ? { ...row, key, masked: false, value: "", needsValue: true } : { ...row, key };
}
