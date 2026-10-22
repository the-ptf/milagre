const { CANCELLED_MESSAGE } = require("./permissions.cjs");

// Questions an agent asks the user mid-turn, in the shape of the `question-request` event, and the
// replies each agent expects. A request is
//   { requestId, questions: [{ id, header, question, options: [{ label, description? }],
//     multiSelect, allowOther, secret }] }
// The user's answers map each question id to the labels picked and any typed answer,
//   { [questionId]: string[] }
// or are null to dismiss the question. A question ends "answered", "dismissed", or "cancelled"
// when its turn stops first.

const DISMISSED_MESSAGE =
  "The user closed the question without picking an answer. If they sent a message instead, follow it; otherwise carry on without the answer, or ask in your reply if you can't.";
const UNSHOWN_MESSAGE = "Milagre couldn't show this question. Ask it in your reply instead.";
const MAX_QUESTIONS = 10;
const MAX_VALUES = 20;
const MAX_ANSWER = 10_000;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const list = (value) => (Array.isArray(value) ? value : []);

function option(raw) {
  const label = text(raw?.label);
  if (!label) return [];
  const description = text(raw?.description);
  return [description ? { label, description } : { label }];
}

// AskUserQuestion input -> request. Claude reads answers keyed by question text, so the ids are
// positions. Claude always offers an answer of the user's own.
function claudeQuestionRequest(input, options = {}) {
  const questions = list(input?.questions).map((raw, index) => ({
    id: String(index),
    header: text(raw?.header),
    question: text(raw?.question),
    options: list(raw?.options).flatMap(option),
    multiSelect: raw?.multiSelect === true,
    allowOther: true,
    secret: false,
  }));
  if (!questions.length || questions.some((question) => !question.question)) return null;
  return { requestId: String(options.requestId ?? options.toolUseID), questions };
}

// The question's outcome -> the SDK's PermissionResult. Answers go back as Claude's own question
// dialog sends them: keyed by question text, several picks joined with ", ".
function claudeQuestionResult(outcome, input, answers = {}) {
  if (outcome === "answered") {
    const given = list(input.questions).flatMap((question, index) =>
      answers[String(index)]?.length ? [[question.question, answers[String(index)].join(", ")]] : [],
    );
    return { behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(given) } };
  }
  if (outcome === "cancelled") return { behavior: "deny", message: CANCELLED_MESSAGE, interrupt: true };
  if (outcome === "unshown") return { behavior: "deny", message: UNSHOWN_MESSAGE };
  return { behavior: "deny", message: DISMISSED_MESSAGE };
}

// item/tool/requestUserInput params -> request. Codex keys answers by its own question ids, has no
// multi-select, and says per question whether a typed answer is allowed.
function codexQuestionRequest(id, params = {}) {
  const questions = list(params.questions).flatMap((raw) => {
    const questionId = text(raw?.id);
    const question = text(raw?.question);
    if (!questionId || !question) return [];
    const options = list(raw.options).flatMap(option);
    return [
      {
        id: questionId,
        header: text(raw.header),
        question,
        options,
        multiSelect: false,
        allowOther: raw.isOther === true || !options.length,
        secret: raw.isSecret === true,
      },
    ];
  });
  return questions.length ? { requestId: String(id), questions } : null;
}

// The question's outcome -> Codex's ToolRequestUserInputResponse. No answers tells Codex to carry on
// without them.
function codexQuestionResponse(outcome, answers = {}) {
  if (outcome !== "answered") return { answers: {} };
  return { answers: Object.fromEntries(Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }])) };
}

// The renderer is untrusted input: answers are null, or a few question ids each mapped to a few short strings.
function validAnswers(answers) {
  if (answers === null) return true;
  if (typeof answers !== "object" || Array.isArray(answers)) return false;
  const entries = Object.values(answers);
  return (
    entries.length <= MAX_QUESTIONS &&
    entries.every(
      (values) => Array.isArray(values) && values.length <= MAX_VALUES && values.every((value) => typeof value === "string" && value.length <= MAX_ANSWER),
    )
  );
}

// The questions a session is waiting on. Each is settled exactly once: answered or dismissed by the
// user, dismissed when a steering message arrives, or cancelled when its turn stops. `forget` drops
// one the agent withdrew without replying to it.
class PendingQuestions {
  constructor(emit) {
    this.emit = emit;
    // requestId -> { settle, ids }
    this.open = new Map();
  }

  get size() {
    return this.open.size;
  }

  add(request, settle) {
    this.open.set(request.requestId, { settle, ids: new Set(request.questions.map((question) => question.id)) });
    this.emit({ type: "question-request", ...request });
  }

  // Answers to questions the request didn't ask, and blank answers, are dropped; nothing left is a dismissal.
  answer(requestId, answers) {
    const open = this.open.get(requestId);
    if (!open) return false;
    const given = Object.entries(answers ?? {}).flatMap(([id, values]) => {
      const kept = values.map((value) => value.trim()).filter(Boolean);
      return open.ids.has(id) && kept.length ? [[id, kept]] : [];
    });
    return given.length ? this.settle(requestId, "answered", Object.fromEntries(given)) : this.settle(requestId, "dismissed");
  }

  cancel(requestId) {
    return this.settle(requestId, "cancelled");
  }

  settle(requestId, outcome, answers = {}) {
    const open = this.open.get(requestId);
    if (!open) return false;
    this.open.delete(requestId);
    open.settle(outcome, answers);
    this.emit({ type: "question-resolved", requestId, outcome });
    return true;
  }

  forget(requestId) {
    if (!this.open.delete(requestId)) return false;
    this.emit({ type: "question-resolved", requestId, outcome: "cancelled" });
    return true;
  }

  dismissAll() {
    // A copy: settling calls the provider and emits events that may add questions.
    for (const requestId of Array.from(this.open.keys())) this.settle(requestId, "dismissed");
  }

  cancelAll() {
    // A copy: cancellation callbacks can add questions for a later pass.
    for (const requestId of Array.from(this.open.keys())) this.settle(requestId, "cancelled");
  }
}

module.exports = {
  DISMISSED_MESSAGE,
  UNSHOWN_MESSAGE,
  PendingQuestions,
  claudeQuestionRequest,
  claudeQuestionResult,
  codexQuestionRequest,
  codexQuestionResponse,
  validAnswers,
};
