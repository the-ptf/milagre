import { useEffect, useState, type ReactNode } from "react";
import { GitPullRequestDraftIcon, GitPullRequestIcon } from "@hugeicons/core-free-icons";
import {
  GLANCE_PR_LIMIT,
  glanceToday,
  hourShares,
  openPullRequestRows,
  todayKey,
  type GlancePrTone,
  type GlancePullRequest,
  type GlanceToday,
} from "@milagre/shared/new-chat-glance";
import { TOKEN_USAGE_PROVIDER_COLORS, formatTokenCount, formatUsd } from "@milagre/shared/token-usage";
import type { ProviderUsage } from "../model";
import { bridgeForKey } from "../lib/computer-bridge";
import { useSettings } from "../lib/settings";
import { Icon } from "./primitives/Icon";
import { ProviderLogo } from "./ProviderLogo";
import { PROVIDER_NAMES, formatPercent, formatResetsIn, shownPercent, usageTone, visibleProviders } from "./usage/format";
import { useUsage } from "./usage/useUsage";

const TONE: Record<GlancePrTone, string> = {
  green: "text-green-ink",
  orange: "text-orange-ink",
  red: "text-red-ink",
  purple: "text-purple-ink",
  muted: "text-ink-3",
};

const PR_REFRESH_MS = 60_000;
const NO_ROWS: GlancePullRequest[] = [];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// The repository's open PRs (the host reads gh at most once a minute), again each minute and when a Project PR changes.
// An older host without the command answers nothing, and the card stays away.
function useOpenPullRequests(projectKey: string | null) {
  const [found, setFound] = useState<{ key: string; rows: GlancePullRequest[] } | null>(null);
  useEffect(() => {
    if (!projectKey) return;
    const bridge = bridgeForKey(projectKey);
    let disposed = false;
    const read = () =>
      // An older host, or a bridge without the command, answers nothing: the card stays away.
      (bridge.listOpenPullRequests?.(projectKey) ?? Promise.resolve([]))
        .then((list) => {
          if (!disposed) setFound({ key: projectKey, rows: openPullRequestRows(list) });
          return undefined;
        })
        .catch(() => {});
    void read();
    const timer = window.setInterval(() => void read(), PR_REFRESH_MS);
    const off = bridge.onPullRequestsChanged?.((change) => {
      if (change.projectPath === projectKey) void read();
    });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      off?.();
    };
  }, [projectKey]);
  // Another Project's rows never show while its own read is on the way.
  return found && found.key === projectKey ? found.rows : NO_ROWS;
}

// Today's tokens on the Project's computer, read by the hour; a scan or price refresh reads it again.
function useToday(scopeKey: string) {
  const [today, setToday] = useState<GlanceToday | null>(null);
  useEffect(() => {
    const bridge = bridgeForKey(scopeKey);
    let disposed = false;
    const read = () => {
      const day = todayKey();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      bridge
        .readTokenUsage?.({ range: "24h", timeZone, days: { from: day, to: day } })
        ?.then((report) => {
          if (!disposed) setToday(glanceToday(report));
          return undefined;
        })
        .catch(() => {});
    };
    read();
    const off = bridge.onTokenUsageChanged?.(read);
    return () => {
      disposed = true;
      off?.();
    };
  }, [scopeKey]);
  return today;
}

function Card({ title, count, aside, children, delay }: { title: string; count?: number; aside?: string | null; children: ReactNode; delay: number }) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-3 rounded-window border border-line bg-surface/70 p-4"
      style={{ animation: `fade-up var(--duration-slow) var(--ease-enter) ${delay}ms both` }}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-12 font-semibold text-ink-2">
          {title}
          {count !== undefined && <span className="ml-1.5 font-normal text-ink-3 tabular-nums">{count}</span>}
        </h2>
        {aside && <span className="truncate text-11 text-ink-3 tabular-nums">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function PullRequestsCard({ rows }: { rows: GlancePullRequest[] }) {
  return (
    <Card title="Open pull requests" count={rows.length} delay={60}>
      <ul className="-mx-2 -mb-1 flex flex-col">
        {rows.slice(0, GLANCE_PR_LIMIT).map((pr) => (
          <li key={pr.url}>
            {/* ChatComposer opens a PR link in the PR panel (onOpenPullRequestLink), or in the browser. */}
            <a href={pr.url} className="flex min-w-0 items-center gap-2.5 rounded-control px-2 py-2 transition-colors hover:bg-hover">
              <span className={`flex shrink-0 ${TONE[pr.tone]}`}>
                <Icon icon={pr.draft ? GitPullRequestDraftIcon : GitPullRequestIcon} size={14} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-12 font-medium text-ink">{pr.title}</span>
                <span className="truncate text-11 text-ink-3">
                  #{pr.number} · {pr.status}
                </span>
              </span>
              {pr.age && <span className="shrink-0 text-11 text-ink-3 tabular-nums">{pr.age}</span>}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function providerSummary(usage: ProviderUsage, display: "used" | "remaining") {
  return usage.windows
    .slice(0, 2)
    .map((window) => `${formatPercent(shownPercent(window.usedPercent, display))} ${window.shortLabel}`)
    .join("  ·  ");
}

function UsageCard({ providers }: { providers: ProviderUsage[] }) {
  const { usageDisplay } = useSettings();
  // When the card opened: a new Chat's screen is short-lived, and the next one reads the reset again.
  const [now] = useState(Date.now);
  // The closest limit's reset: what decides whether to start something big now.
  const closest = providers
    .flatMap((usage) => usage.windows.map((window) => ({ provider: usage.provider, window })))
    .sort((a, b) => b.window.usedPercent - a.window.usedPercent)[0];
  const resets = closest ? formatResetsIn(closest.window.resetsAt, now) : null;
  return (
    <Card title="Plan usage" aside={resets && closest ? `${PROVIDER_NAMES[closest.provider]} · ${resets.toLowerCase()}` : null} delay={120}>
      <div className="flex flex-col gap-3">
        {providers.map((usage) => {
          const peak = usage.windows.reduce((max, window) => Math.max(max, window.usedPercent), 0);
          const tone = usageTone(peak);
          const fill =
            tone === "critical" ? "var(--red)" : tone === "warning" ? "var(--orange)" : (TOKEN_USAGE_PROVIDER_COLORS[usage.provider] ?? "var(--ink)");
          return (
            <div key={usage.provider} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-12">
                <ProviderLogo provider={usage.provider} size={13} />
                <span className="flex-1 font-medium text-ink">{PROVIDER_NAMES[usage.provider]}</span>
                <span className="text-11 text-ink-2 tabular-nums">{usage.windows.length > 0 ? providerSummary(usage, usageDisplay) : "—"}</span>
              </div>
              <span aria-hidden className="relative block h-1 overflow-hidden rounded-full bg-line-strong">
                <span
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-slow motion-reduce:transition-none"
                  style={{ width: `${shownPercent(peak, usageDisplay)}%`, background: fill }}
                />
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TodayCard({ today }: { today: GlanceToday }) {
  const shares = hourShares(today.hours);
  const stats = [
    { value: formatUsd(today.costUsd), label: "spent" },
    { value: formatTokenCount(today.tokens), label: "tokens" },
    { value: String(today.chats), label: today.chats === 1 ? "Chat" : "Chats" },
  ];
  return (
    <Card title="Today" aside="Token usage" delay={180}>
      <dl className="grid grid-cols-3 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
            <dd className="truncate text-17 font-semibold text-ink tabular-nums">{stat.value}</dd>
            <dt className="text-11 text-ink-3">{stat.label}</dt>
          </div>
        ))}
      </dl>
      <div aria-hidden className="flex h-8 items-end gap-[3px]">
        {HOURS.map((hour) => {
          const share = shares[hour] ?? 0;
          return (
            <span
              key={hour}
              className={`min-w-0 flex-1 rounded-inline ${hour > today.currentHour || share === 0 ? "bg-line-strong" : hour === today.currentHour ? "bg-accent" : "bg-accent/60"}`}
              style={{ height: share > 0 ? `${Math.max(12, share * 100)}%` : "3px" }}
            />
          );
        })}
      </div>
    </Card>
  );
}

/**
 * Under a new Chat's composer: the repository's open PRs, plan usage and today's tokens. Each card shows only with something
 * in it; a Chats home draft has no Project, so no PRs.
 */
export function NewChatGlance({ projectKey, scopeKey }: { projectKey: string | null; scopeKey: string }) {
  const prs = useOpenPullRequests(projectKey);
  const usage = useUsage(scopeKey);
  const today = useToday(scopeKey);
  const providers = usage.snapshot ? visibleProviders(usage.snapshot).filter((item) => item.windows.length > 0 || item.status === "ok") : [];
  const usageCard = providers.length > 0 ? <UsageCard providers={providers} /> : null;
  const todayCard = today && (today.costUsd > 0 || today.tokens > 0) ? <TodayCard today={today} /> : null;
  if (prs.length === 0 && !usageCard && !todayCard) return null;
  return (
    <div data-new-chat-glance className="@container chat-gutter mx-auto w-full max-w-[var(--chat-width)] shrink-0 px-1.5 pt-5">
      <div className="grid grid-cols-1 items-start gap-3.5 @[36rem]:grid-cols-2">
        {prs.length > 0 && <PullRequestsCard rows={prs} />}
        {prs.length > 0 ? (
          (usageCard || todayCard) && (
            <div className="flex min-w-0 flex-col gap-3.5">
              {usageCard}
              {todayCard}
            </div>
          )
        ) : (
          <>
            {usageCard}
            {todayCard}
          </>
        )}
      </div>
    </div>
  );
}
