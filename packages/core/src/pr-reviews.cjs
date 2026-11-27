const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { REVIEW_FINDING_STATUSES, parseReviewReport, reviewCounts, reviewFixMessage } = require("@milagre/shared/pr-review");

const MAX_REVIEWS = 300;
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const findingId = (url, finding) =>
  createHash("sha1")
    .update(`${url}\n${finding.path}\n${finding.line ?? ""}\n${finding.title}`)
    .digest("hex")
    .slice(0, 12);

const sameFix = (a, b) => a.severity === b.severity && a.body === b.body && a.suggestion === b.suggestion;

function readFile(file) {
  try {
    const raw = object(JSON.parse(fs.readFileSync(file, "utf8")));
    return { settings: { enabled: object(raw.settings).enabled === true }, reviews: object(raw.reviews) };
  } catch {
    return { settings: { enabled: false }, reviews: {} };
  }
}

/**
 * The review agent's reports, one per PR, in `<dataDir>/pr-reviews.json`, and its Experimental switch. `babysit(url,
 * findings)` hands open high-severity findings to the PR's Babysit Heartbeat and resolves whether one took them.
 */
function createPrReviews({ file, emit = () => {}, now = Date.now, sendFix, babysit = async () => false }) {
  let data = readFile(file);
  function write() {
    const entries = Object.entries(data.reviews).toSorted(([, a], [, b]) => b.reviewedAt - a.reviewedAt);
    data.reviews = Object.fromEntries(entries.slice(0, MAX_REVIEWS));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data));
    fs.renameSync(temp, file);
  }

  function saveSettings(patch) {
    if (typeof object(patch).enabled !== "boolean") throw new Error("Review agent settings take enabled: true or false.");
    data.settings = { enabled: patch.enabled };
    write();
    emit("pr-reviews:settings", data.settings);
    return data.settings;
  }

  async function report(input, chatId = null) {
    if (!data.settings.enabled) throw new Error("The review agent is off. Turn it on in Settings › Church › Review agent.");
    const parsed = parseReviewReport(input);
    if (parsed instanceof Error) throw parsed;
    const before = new Map((data.reviews[parsed.url]?.findings ?? []).map((finding) => [finding.id, finding]));
    const findings = parsed.findings.map((finding) => {
      const id = findingId(parsed.url, finding);
      const previous = before.get(id);
      const status = previous?.status === "sent" && !sameFix(previous, finding) ? "open" : (previous?.status ?? "open");
      return { id, ...finding, status };
    });
    const review = { url: parsed.url, summary: parsed.summary, reviewedAt: now(), chatId, findings, babysat: false };
    data.reviews[parsed.url] = review;
    write();
    emit("pr-reviews:changed", { url: parsed.url });
    const urgent = findings.filter((finding) => finding.severity === "high" && finding.status === "open");
    if (urgent.length && (await babysit(parsed.url, urgent).catch(() => false))) {
      review.babysat = true;
      for (const finding of urgent) if (finding.status === "open") finding.status = "sent";
      write();
      emit("pr-reviews:changed", { url: parsed.url });
    }
    return { url: parsed.url, findings: findings.length, ...reviewCounts(review), babysat: review.babysat };
  }

  function setStatus(request) {
    const { url, ids, status } = object(request);
    const review = data.reviews[url];
    if (!review) throw new Error("This PR has no review.");
    if (!REVIEW_FINDING_STATUSES.includes(status)) throw new Error("status is open, sent or dismissed.");
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    for (const finding of review.findings) if (wanted.has(finding.id)) finding.status = status;
    write();
    emit("pr-reviews:changed", { url });
    return review;
  }

  return {
    settings: () => data.settings,
    saveSettings,
    read: (url) => data.reviews[url] ?? null,
    counts: () => Object.fromEntries(Object.values(data.reviews).map((review) => [review.url, { ...reviewCounts(review), reviewedAt: review.reviewedAt }])),
    async fix({ url, id }) {
      const review = data.reviews[url];
      const finding = review?.findings.find((item) => item.id === id);
      if (!data.settings.enabled || !finding || finding.status !== "open") throw new Error("This finding is no longer open for fixes.");
      const message = reviewFixMessage(url, [finding]);
      const messageId = `pr-review:${review.reviewedAt}:${createHash("sha256").update(message).digest("hex")}`;
      await sendFix(review, message, messageId);
      const current = data.reviews[url]?.findings.find((item) => item.id === id);
      if (current?.status === "open" && sameFix(current, finding)) setStatus({ url, ids: [id], status: "sent" });
      return data.reviews[url];
    },
    report,
    setStatus,
  };
}

/** Registers the commands. `babysit` comes from the Routines runtime once it exists. */
function registerPrReviews({ commands, dataDir, emit, babysit, sendFix }) {
  const reviews = createPrReviews({ file: path.join(dataDir, "pr-reviews.json"), emit, sendFix, babysit: (...args) => babysit()(...args) });
  commands.handle("pr-reviews:settings:read", () => reviews.settings());
  commands.handle("pr-reviews:settings:save", (_event, patch) => reviews.saveSettings(patch));
  commands.handle("pr-reviews:read", (_event, url) => reviews.read(url));
  commands.handle("pr-reviews:counts", () => reviews.counts());
  commands.handle("pr-reviews:set-status", (_event, request) => reviews.setStatus(request));
  commands.handle("pr-reviews:fix", (_event, request) => reviews.fix(request));
  return reviews;
}

module.exports = { createPrReviews, registerPrReviews };
