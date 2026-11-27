const { reviewBabysitChanges } = require("@milagre/shared/pr-review");

/** Hands review findings to the Babysit Heartbeat watching `url`, as the PR poller hands changes; false without one. */
function babysitReviewFindings({ store, scheduler, now }, url, findings) {
  const routine = store.list().find((item) => item.enabled && !item.completedAt && item.trigger.kind === "pull-request" && item.trigger.url === url);
  if (!routine) return false;
  const at = now();
  const changes = reviewBabysitChanges(findings);
  const event = { kind: "pull-request", key: `review:${url}:${at}`, summary: changes.map((change) => change.text).join("\n"), changes };
  const branch = store.prSnapshot(routine.id)?.snapshot?.headRef;
  const [result] = scheduler.enqueueEvents([{ at, routineId: routine.id, event: branch ? { ...event, branch } : event }]);
  return Boolean(result?.queued);
}

module.exports = { babysitReviewFindings };
