const withoutDraft = ({
  handoverDraft: _handoverDraft,
  resumeTurn: _resumeTurn,
  limitResume: _limitResume,
  limitTurn: _limitTurn,
  suggestion: _suggestion,
  suggestionTurnId: _suggestionTurn,
  ...rest
}) => rest;

function sentMessage({ id, sessionId, body, images, files, brief, request, model }) {
  return {
    id,
    session_id: sessionId,
    body,
    images,
    ...(files.length ? { files } : {}),
    ...(brief !== undefined ? { handoverBrief: brief } : {}),
    context: request.context ?? null,
    ...(request.operationId ? { operationId: request.operationId } : {}),
    role: "user",
    model,
  };
}
module.exports = { withoutDraft, sentMessage };
