const short = (value, length) =>
  Array.from(
    String(value ?? "")
      // oxlint-disable-next-line no-control-regex -- Strip controls from OS presentation text.
      .replace(/[\u0000-\u001f]/g, " ")
      .trim(),
  )
    .slice(0, length)
    .join("");
const active = new Set(["initializing", "running"]);
const recommendation = /\s*\(recommended\)\s*$/i;

export function activityContent({ chats = [], pending = [], now = Date.now(), mode = "all" }) {
  const ordered = pending.toSorted((a, b) => a.at - b.at);
  let runningCount = 0;
  const rows = (mode === "questions" ? [] : chats)
    .map((chat) => {
      const children = new Map((chat.subagents ?? []).filter((child) => !child.archived && active.has(child.status)).map((child) => [child.id, child]));
      runningCount += (chat.working ? 1 : 0) + children.size;
      return { title: short(chat.title, 60) || "Chat", status: chat.working ? "Working" : children.size ? "Subagents running" : "Waiting" };
    })
    .slice(0, 3);
  const first = ordered[0];
  let question = null;
  if (first) {
    const questions = first.kind === "question" ? (first.request?.questions ?? []) : [];
    const index = Math.max(
      0,
      questions.findIndex((q) => !first.answers?.[q.id]?.length),
    );
    const q = questions[index];
    const labels = (q?.options ?? []).slice(0, 2).map((option, i) => ({ index: i, label: String(option.label).replace(recommendation, "") }));
    const canAnswer =
      !!q &&
      !q.secret &&
      !q.multiSelect &&
      Array.from(String(q.question ?? "")).length <= 120 &&
      labels.length > 0 &&
      labels.every((option) => option.label.length > 0 && Array.from(option.label).length <= 24);
    question = {
      target: first.target,
      title: short(first.title, 60) || "Chat",
      text: first.kind === "approval" ? "Approval needed in Chat" : q?.secret ? "Input needed in Chat" : short(q?.question, 120) || "Input needed in Chat",
      position: index + 1,
      total: Math.max(1, questions.length),
      choices: canAnswer ? labels : [],
      canAnswer,
    };
  }
  return { version: 1, updatedAt: now, runningCount, waitingCount: ordered.length, rows, question };
}
