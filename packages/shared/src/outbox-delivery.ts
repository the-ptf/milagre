import type { ChatSendRequest, CoordinatorState, LinkSendRequest, WorktreeRequest } from "./model.ts";
import type { OutboxItem } from "./outbox.mjs";

export type OutboxTransport = {
  open(): Promise<{ sessions: Record<string, { archived?: boolean }>; worktrees?: CoordinatorState["worktrees"] }>;
  receipt(id: string): Promise<{ sessionId: number } | null>;
  create(request: WorktreeRequest): Promise<{ worktreeId: number; project: { state: CoordinatorState } }>;
  upload(name: string, base64: string): Promise<{ path: string }>;
  send(request: ChatSendRequest): Promise<{ sessionId: number }>;
  sendLink(request: LinkSendRequest): Promise<{ sessionId: number }>;
};

/** Receipt support is required before mutations: older computers fail visibly instead of risking duplicate delivery. */
export async function deliverOutbox(original: OutboxItem, update: (patch: Partial<OutboxItem>) => Promise<OutboxItem>, transport: OutboxTransport) {
  let item = original;
  const state = await transport.open();
  const receipt = await transport.receipt(item.id);
  if (receipt) return receipt;
  if (item.request.sessionId != null) {
    const chat = state.sessions[item.request.sessionId];
    if (!chat || chat.archived) throw new Error("This Chat was archived or removed. Your message is still saved on this device.");
  } else if (!item.link && !item.createWorktree && !state.worktrees?.[item.request.worktreeId]) {
    throw new Error("This Worktree was removed. Your message is still saved on this device.");
  }
  if (item.createWorktree) {
    item = await update({ phase: "creating" });
    const created = await transport.create(item.createWorktree!);
    const chat = Object.values(created.project.state.sessions).find((entry) => entry.worktree_id === created.worktreeId && !entry.archived);
    if (!chat) throw new Error("The new Worktree has no Chat.");
    item = await update({ phase: "ready", createWorktree: undefined, request: { ...item.request, sessionId: chat.id, worktreeId: created.worktreeId } });
  }
  const images = [...item.request.images];
  const files = [...item.request.files];
  for (const attachment of item.attachments) {
    const path = attachment.base64 !== undefined ? (await transport.upload(attachment.name, attachment.base64)).path : attachment.path;
    if (!path) throw new Error(`Attachment data is missing for ${attachment.name}. Recover the message and attach it again.`);
    if (attachment.imageId) images.push({ id: attachment.imageId, name: attachment.name, path });
    else files.push(path);
  }
  const request = {
    ...item.request,
    clientMessageId: item.id,
    images,
    files,
    prompt:
      item.request.prAction || item.request.linearIssue
        ? item.request.prompt
        : files.length
          ? `${item.request.body || "Please review the attached files."}\n\nAttached files:\n${files.join("\n")}`
          : item.request.body || "Describe the attached images.",
  };
  await update({ phase: "dispatching" });
  const result = await (item.link ? transport.sendLink({ ...request, ...item.link }) : transport.send(request));
  return { ...result, worktreeId: request.worktreeId };
}
