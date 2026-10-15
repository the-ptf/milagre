// Requests reviewers on a pull request: victorlucss on every PR he did not
// write, plus whoever in the rotation was asked least recently, until the PR
// has two reviewers besides its author. Run by .github/workflows/reviewers.yml.

const LEAD = "victorlucss";
const ROTATION = ["marcosgenesis", "jefo3", "micaelomota", "ericrodriguesfer", "victorsaisse"];
const MIN_REVIEWERS = 2;
const HISTORY_PRS = 50;

/**
 * @param {{ author: string, present: string[], lastRequested: Record<string, string> }} input
 *   present: users already requested or already reviewing. lastRequested: login to ISO time.
 * @returns {string[]} logins to request, in order
 */
function pickReviewers({ author, present, lastRequested }) {
  const have = new Set(present.filter((login) => login !== author));
  const picked = [];
  if (author !== LEAD && !have.has(LEAD)) picked.push(LEAD);
  const candidates = ROTATION.filter((login) => login !== author && !have.has(login)).toSorted(
    (a, b) => (lastRequested[a] ?? "").localeCompare(lastRequested[b] ?? "") || ROTATION.indexOf(a) - ROTATION.indexOf(b),
  );
  while (have.size + picked.length < MIN_REVIEWERS && candidates.length) picked.push(candidates.shift());
  return picked;
}

async function github(path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`${body ? "POST" : "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function lastRequestTimes(owner, name) {
  const query = `query($owner: String!, $name: String!, $count: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: $count, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { timelineItems(last: 20, itemTypes: REVIEW_REQUESTED_EVENT) {
          nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
        } }
      }
    }
  }`;
  const result = await github("/graphql", { query, variables: { owner, name, count: HISTORY_PRS } });
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  const times = {};
  for (const pr of result.data.repository.pullRequests.nodes) {
    for (const event of pr.timelineItems.nodes) {
      const login = event.requestedReviewer?.login;
      if (login && !(times[login] > event.createdAt)) times[login] = event.createdAt;
    }
  }
  return times;
}

async function main() {
  const [owner, name] = process.env.GITHUB_REPOSITORY.split("/");
  const number = process.env.PR_NUMBER;
  const pr = await github(`/repos/${owner}/${name}/pulls/${number}`);
  const reviews = await github(`/repos/${owner}/${name}/pulls/${number}/reviews?per_page=100`);
  const present = [...pr.requested_reviewers.map((user) => user.login), ...reviews.map((review) => review.user.login)];
  const reviewers = pickReviewers({ author: pr.user.login, present, lastRequested: await lastRequestTimes(owner, name) });
  if (!reviewers.length) return console.log(`#${number} already has ${MIN_REVIEWERS} reviewers`);
  if (process.env.DRY_RUN) return console.log(`#${number} would request ${reviewers.join(", ")}`);
  await github(`/repos/${owner}/${name}/pulls/${number}/requested_reviewers`, { reviewers });
  console.log(`#${number} requested ${reviewers.join(", ")}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { pickReviewers, LEAD, ROTATION };
