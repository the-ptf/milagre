import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { findingsLabel, reviewCounts, type PrReview, type ReviewFinding } from "@milagre/shared/pr-review";
import type { PullRequestDetail } from "@milagre/shared/pull-request-review";
import { ReviewButton } from "./pull-request-row";
import { useOrchestrator } from "./use-orchestrator";
import { useOrchestratorBoard } from "./use-orchestrator-board";
import { mentionsUrl, reviewPrompt, reviewingUrls } from "./pull-requests-page";
import { repoOf } from "./pr-review";
import type { Client } from "./client";
import { space } from "./design-tokens";
import { useReviewAgent } from "./review-agent";
import { useRpc } from "./use-rpc";
import { useSession } from "./session";
import { PillButton, ErrorNotice, useStyles } from "./ui";
import { useTheme } from "./theme";

function StartReview({ pr, report }: { pr: PullRequestDetail; report: boolean }) {
  const session = useSession();
  const { snapshot, store } = useOrchestrator(session.client);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const tasks = useMemo(() => snapshot?.tasks.filter((t) => mentionsUrl(t.prompt, pr.url)) ?? [], [snapshot?.tasks, pr.url]);
  const { items } = useOrchestratorBoard(tasks);
  if (!snapshot?.settings.enabled || !store) return null;
  const send = async () => {
    setSending(true);
    setError("");
    try {
      await store.send(reviewPrompt({ ...pr, repo: repoOf(pr.url) }, { report }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the review.");
    } finally {
      setSending(false);
    }
  };
  return (
    <View style={{ alignItems: "flex-start", gap: space.sm }}>
      <ReviewButton color={snapshot.settings.mascotColor} reviewing={sending || reviewingUrls([pr.url], items).has(pr.url)} onPress={() => void send()} />
      {!!error && <ErrorNotice message={error} />}
    </View>
  );
}

export function ReviewFindings({ client, pr }: { client: Client; pr: PullRequestDetail }) {
  const url = pr.url;
  const session = useSession();
  const { enabled } = useReviewAgent(session.client);
  const { data: review, refresh } = useRpc<PrReview>(enabled ? client : null, "pr-reviews:read", [url], true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const styles = useStyles();
  const { colors } = useTheme();
  const start = <StartReview pr={pr} report={!!enabled} />;
  if (!enabled || !review || review.url !== url) return start;
  async function act(finding: ReviewFinding, action: "fix" | "open" | "dismissed") {
    setError("");
    setBusy(true);
    try {
      if (action === "fix") await client.call("pr-reviews:fix", [{ url, id: finding.id }]);
      else await client.call("pr-reviews:set-status", [{ url, ids: [finding.id], status: action }]);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this finding.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: space.sm }}>
      {start}
      <PillButton secondary title={`Review findings · ${findingsLabel(reviewCounts(review).open)}`} onPress={() => setOpen(!open)} />
      {open && (
        <>
          {!!review.summary && <Text style={styles.muted}>{review.summary}</Text>}
          {review.findings.map((f) => (
            <View key={f.id} style={[styles.card, { gap: space.sm }]}>
              <Text style={[styles.caption, { color: f.severity === "high" ? colors.redInk : colors.ink2 }]}>
                {f.severity} · {f.path}
                {f.line ? `:${f.line}` : ""}
              </Text>
              <Text style={styles.label}>{f.title}</Text>
              {f.status === "dismissed" ? (
                <PillButton secondary title="Restore finding" disabled={busy} onPress={() => void act(f, "open")} />
              ) : (
                <>
                  {!!f.body && <Text style={styles.text}>{f.body}</Text>}
                  {!!f.suggestion && <Text style={styles.muted}>{f.suggestion}</Text>}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    {f.status === "open" ? (
                      <PillButton secondary title="Fix in Chat" disabled={busy} onPress={() => void act(f, "fix")} />
                    ) : (
                      <Text style={styles.caption}>Sent for a fix</Text>
                    )}
                    <PillButton secondary title="Dismiss" disabled={busy} onPress={() => void act(f, "dismissed")} />
                  </View>
                </>
              )}
            </View>
          ))}
          {!!error && <ErrorNotice message={error} />}
        </>
      )}
    </View>
  );
}
