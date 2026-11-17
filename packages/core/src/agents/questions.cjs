const { CANCELLED_MESSAGE } = require("./permissions.cjs");

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
function codexQuestionResponse(outcome, answers = {}) {
  if (outcome !== "answered") return { answers: {} };
  return { answers: Object.fromEntries(Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }])) };
}

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

const MAX_ANSWER_IMAGES = 10;

function answerImages(images) {
  if (images === undefined || images === null) return {};
  if (typeof images !== "object" || Array.isArray(images)) throw new Error("Invalid images for an agent question.");
  if (Object.values(images).some((attached) => !Array.isArray(attached))) throw new Error("Invalid images for an agent question.");
  const entries = Object.entries(images).filter(([, attached]) => attached.length);
  if (entries.reduce((total, [, attached]) => total + attached.length, 0) > MAX_ANSWER_IMAGES)
    throw new Error(`Attach at most ${MAX_ANSWER_IMAGES} images to your answers.`);
  return Object.fromEntries(entries);
}

function withAnswerImages(answers, stored) {
  const agent = { ...answers };
  const shown = { ...answers };
  for (const [id, images] of Object.entries(stored)) {
    if (!images.length) continue;
    agent[id] = [...(agent[id] ?? []), ...images.map((image) => `Image the user attached: ${image.path} (open the file to see it)`)];
    shown[id] = [...(shown[id] ?? []), images.length === 1 ? "1 image" : `${images.length} images`];
  }
  return { agent, shown };
}

class PendingQuestions {
  constructor(emit) {
    this.emit = emit;
    this.open = new Map();
  }

  add(request, settle) {
    this.open.set(request.requestId, { settle, ids: new Set(request.questions.map((question) => question.id)) });
    this.emit({ type: "question-request", ...request });
  }

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
    for (const requestId of Array.from(this.open.keys())) this.settle(requestId, "dismissed");
  }

  cancelAll() {
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
  answerImages,
  withAnswerImages,
};
