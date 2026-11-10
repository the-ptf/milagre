const test = require("node:test");
const assert = require("node:assert/strict");
const { redactFields, isClean, knownEntries } = require("./bug-report-redact.cjs");

// What the host knows about a made-up user: a consultancy working on a client's payments service.
const KNOWN = [
  { kind: "org", value: "northwind-health" },
  { kind: "repo", value: "claims-ledger" },
  { kind: "project", value: "claims-ledger" },
  { kind: "project", value: "Orion Billing" },
  { kind: "worktree", value: "/Users/mreyes/.milagre/worktrees/claims-ledger/chat-7k2p" },
  { kind: "worktree", value: "/Users/mreyes/.milagre/worktrees/claims-ledger/chat-9q4z" },
  { kind: "worktree", value: "chat-7k2p" },
  { kind: "branch", value: "mreyes/adjudication-retry" },
  { kind: "branch", value: "main" },
  { kind: "chat", value: "Fix duplicate claim adjudication for Medicaid batch" },
  { kind: "home", value: "/Users/mreyes" },
  { kind: "person", value: "Marisol Reyes" },
  { kind: "email", value: "marisol.reyes@northwind-health.com" },
  { kind: "computer", value: "Marisols-MacBook-Pro" },
  { kind: "host", value: "build-07.nwh.internal" },
];

const redact = (text, options) => redactFields({ text }, KNOWN, options).fields.text;
const leaks = (text, ...values) => values.filter((value) => text.toLowerCase().includes(value.toLowerCase()));

test("every value the host knows is the user's becomes a placeholder, the same one everywhere", () => {
  const { fields } = redactFields(
    {
      title: "Delegation from claims-ledger hangs on Marisols-MacBook-Pro",
      body: [
        "In Orion Billing a Delegation to northwind-health/claims-ledger never reported back.",
        "Chat 'Fix duplicate claim adjudication for Medicaid batch' on branch mreyes/adjudication-retry.",
        "Worktree /Users/mreyes/.milagre/worktrees/claims-ledger/chat-7k2p waited on /Users/mreyes/.milagre/worktrees/claims-ledger/chat-9q4z.",
        "Marisol Reyes (marisol.reyes@northwind-health.com) saw it after build-07.nwh.internal went offline.",
      ].join("\n"),
    },
    KNOWN,
  );
  const all = `${fields.title}\n${fields.body}`;
  assert.deepEqual(
    leaks(all, "claims-ledger", "northwind", "Orion Billing", "Medicaid", "mreyes", "Marisol", "Reyes", "MacBook", "nwh.internal", "chat-7k2p", "chat-9q4z"),
    [],
  );
  assert.match(fields.title, /^Delegation from <repo> hangs on <computer>$/);
  assert.match(fields.body, /a Delegation to <org>\/<repo> never/);
  // Two Worktrees: two placeholders, so the report still says one waited on the other.
  assert.match(fields.body, /Worktree <worktree-a> waited on <worktree-b>\./);
  // A branch everyone has is not private, so "main" in prose survives.
  assert.equal(redact("the main window froze"), "the main window froze");
});

test("paths, links, addresses, keys and references Milagre can't recognise are replaced too", () => {
  const text = [
    "Opened /Users/mreyes/Code/client-portal/src/claims/adjudicate.ts and ~/Notes/northwind-rfp.md and C:\\Users\\mreyes\\deploy.ps1.",
    "Also packages/edi/parsers/x12.ts, services/fraud/model and rules.yaml.",
    "PR https://github.com/acme-payers/eligibility/pull/1182, issue https://github.com/acme-payers/eligibility/issues/77,",
    "repo https://github.com/acme-payers/eligibility and https://gitlab.acme.dev/payers/edi/-/merge_requests/9 and https://jira.acme.dev/browse/CLM-4410.",
    "Remote git@github.com:acme-payers/eligibility.git; see acme-payers/eligibility#12, PR 4521, #318, CLM-88, @jkowalski.",
    "Token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8, sk-ant-api03-abcdefghijklmnopqrstuv, Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl,",
    "STRIPE_SECRET_KEY=sk_live_51HxQv2abc, AKIAIOSFODNN7EXAMPLE, a UUID 3f2c8a1e-9b7d-4c3e-8f1a-2b6d9e0c4a7f.",
    "Host api.acmepayers.com, mDNS printer.local, 192.168.4.21:8443, fe80:0:0:0:200:f8ff:fe21:67cf, commit 9f8e7d6c and 1a2b3c4d5e6f7a8b9c0d.",
  ].join("\n");
  const out = redact(text);
  assert.deepEqual(
    leaks(
      out,
      "client-portal",
      "adjudicate",
      "northwind-rfp",
      "deploy.ps1",
      "x12",
      "fraud",
      "rules.yaml",
      "acme",
      "eligibility",
      "1182",
      "CLM-",
      "jkowalski",
      "ghp_",
      "sk-ant",
      "eyJ",
      "sk_live",
      "AKIA",
      "3f2c8a1e",
      "printer.local",
      "192.168",
      "fe80",
      "9f8e7d6c",
      "1a2b3c4d",
      "4521",
      "#318",
    ),
    [],
  );
  assert.match(out, /PR <pr-a>, issue <issue-a>,/);
  assert.match(out, /STRIPE_SECRET_KEY=<token-[a-z]>/);
  assert.match(out, /PR <pr-[a-z]>, <issue-[a-z]>, <issue-[a-z]>, <person>/);
});

test("fenced code is dropped unless a field keeps it, and kept code is still redacted", () => {
  const code = "```ts\nawait adjudicate(claim, { payer: 'Northwind' })\n```";
  assert.equal(redact(`Before\n${code}\nAfter`), "Before\n<code removed>\nAfter");
  const kept = redactFields({ log: "[routines] poll of /Users/mreyes/Code/claims-ledger failed" }, KNOWN, { keepCode: ["log"] }).fields.log;
  assert.equal(kept, "[routines] poll of <home>/<path> failed");
});

test("a Milagre folder inside a replaced path isn't taken for a branch", () => {
  assert.equal(redact("ENOENT <worktree>/.milagre/report.json"), "ENOENT <worktree><path>");
  assert.equal(redact("on milagre/chat-h5m5 and fix/login-loop"), "on <branch-a> and <branch-b>");
});

test("Milagre's own words, links and version strings stay readable", () => {
  const text =
    "Milagre 0.232.0-beta.26 on macOS 27.0: see https://github.com/the-ptf/milagre-ade/issues/938 and https://relay.milagre.cloud/health. Node.js and UTF-8, SHA-256, GPT-5 are fine at 10 a.m. on 11/10/2026; desktop/phone both. Open Milagre.app.";
  assert.equal(redact(text), text);
});

test("only public URL structure is exempt from redaction, never data on a trusted host", () => {
  const privateUrls = [
    "https://relay.milagre.cloud/pair?token=FAKE_PRIVATE_TOKEN_1234567890&project=claims-ledger",
    "https://github.com/the-ptf/milagre/issues/new?body=claims-ledger&api_key=FAKE_PRIVATE_TOKEN_1234567890",
    "https://claims-ledger:password@relay.milagre.cloud/health",
    "https://relay.milagre.cloud/health#claims-ledger",
    "https://relay.milagre.cloud/claims-ledger",
    "https://claims-ledger.milagre.cloud/health",
    "https://unknown-client.milagre.dev/",
    "https://share.milagre.cloud/s/private-share-id",
    "https://github.com/the-ptf/milagre/blob/private-branch/README.md",
    "https://raw.githubusercontent.com/the-ptf/milagre/private-branch/README.md",
    "https://milagre.cloud/docs/claims-ledger",
    "https://milagre.cloud/docs/%63laims-ledger",
    "https://milagre.cloud/docs/%2563laims-ledger",
    "https://%63laims-ledger.milagre.cloud/",
    "https://relay.milagre.cloud/health?%74oken=abc",
    "https://relay.milagre.cloud/health#%2574oken%253Dabc",
    "https://relay.milagre.cloud/health?x=%2FUsers%2Fmreyes",
    "https://relay.milagre.cloud/health?x=Orion+Billing",
    "https://relay.milagre.cloud:12345/health",
    "https://relay.milagre.cloud/private/../health",
    "https://relay.milagre.cloud\\private\\..\\health",
    "ftp://relay.milagre.cloud/health",
    "www.milagre.cloud/docs/cli?password=abc",
    "https://milagre.cloud.evil.example/docs",
  ];
  for (const url of privateUrls) {
    assert.equal(isClean(url, KNOWN), false, url);
    const out = redact(`${url}.`);
    assert.match(out, /^<(?:url|repo|pr|issue)>\.$/, url);
    assert.ok(isClean(out, KNOWN), out);
    assert.equal(redact(out), out);
  }
});

test("public health, docs and issue links stay useful, unless they contain a known private value", () => {
  for (const url of [
    "https://relay.milagre.cloud/health",
    "https://milagre.cloud/docs",
    "https://milagre.cloud/docs/cli",
    "https://www.milagre.dev/docs/cli",
    "https://github.com/the-ptf/milagre",
    "https://github.com/the-ptf/milagre/issues/938",
    "https://github.com/the-ptf/milagre-ade/pull/999",
    "https://github.com/the-ptf/milagre/issues/new",
  ]) {
    assert.equal(redact(url), url);
    assert.ok(isClean(url, KNOWN));
  }
  const known = [{ kind: "project", value: "relay" }];
  assert.equal(isClean("https://relay.milagre.cloud/health", known), false);
  assert.equal(redactFields({ text: "https://relay.milagre.cloud/health" }, known).fields.text, "<url>");
});

test("bare private hostnames cannot use the public Milagre host exception", () => {
  for (const host of ["claims-ledger.milagre.cloud", "unknown-client.milagre.dev", "private.relay.milagre.cloud"]) {
    assert.equal(redact(host), "<host>", host);
    assert.equal(isClean(host, KNOWN), false, host);
  }
  for (const host of ["milagre.cloud", "www.milagre.dev", "relay.milagre.cloud"]) assert.equal(redact(host), host);
  const known = [{ kind: "project", value: "relay" }];
  assert.equal(isClean("relay.milagre.cloud", known), false);
  assert.equal(redactFields({ text: "relay.milagre.cloud" }, known).fields.text, "<project>");
});

test("redacted text is clean, and stays the same when checked again", () => {
  const text = "Worktree /Users/mreyes/.milagre/worktrees/claims-ledger/chat-7k2p, token=abcdef123456, https://github.com/acme-payers/x/pull/3";
  const once = redact(text);
  assert.ok(isClean(once, KNOWN));
  assert.equal(redact(once), once);
  assert.equal(isClean(text, KNOWN), false);
});

test("text the user edited keeps its placeholders, and a new value gets a name that doesn't clash", () => {
  const edited = "<repo-a> and <repo-b> broke; now also northwind-health and claims-ledger";
  const out = redactFields({ body: edited }, KNOWN, { keepCode: ["body"] }).fields.body;
  assert.equal(out, "<repo-a> and <repo-b> broke; now also <org> and <repo-c>");
});

test("common or short known values are skipped, longest first", () => {
  const entries = knownEntries([
    { kind: "project", value: "app" },
    { kind: "branch", value: "develop" },
    { kind: "project", value: "ab" },
    { kind: "project", value: "2024" },
    { kind: "home", value: "/Users/mreyes/" },
    { kind: "worktree", value: "/Users/mreyes/work/claims" },
    { kind: "nonsense", value: "whatever" },
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.value),
    ["/Users/mreyes/work/claims", "/Users/mreyes"],
  );
});

test("control characters can't smuggle text past the placeholders", () => {
  const out = redact("a\u0001b\u0002 northwind-health \u0003x\u0004");
  assert.equal(out, "ab <org> x");
});
