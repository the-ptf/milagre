/** Field-level errors shared by semantic checks and Zod validation. */
export function designError(message, path) {
  return Object.assign(new Error(message), { issues: [{ path, message }] });
}
export function designErrorIssues(error) {
  const flatten = (issue, prefix = []) =>
    issue.code === "invalid_union"
      ? issue.errors[0].flatMap((child) => flatten(child, [...prefix, ...issue.path]))
      : [{ path: [...prefix, ...(issue.path ?? [])], message: issue.message }];
  const issues = error.issues?.flatMap((issue) => flatten(issue)) ?? [{ path: [], message: error.message ?? String(error) }];
  const unique = new Map(issues.map((issue) => [JSON.stringify(issue), issue]));
  return [...unique.values()].slice(0, 10);
}
export function conciseDesignError(error) {
  if (!error.issues) return error;
  const issues = designErrorIssues(error);
  return Object.assign(new Error(issues.map((issue) => `${issue.path.length ? issue.path.join(".") + ": " : ""}${issue.message}`).join("\n")), {
    issues,
    ...(error.code ? { code: error.code } : {}),
  });
}
