import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { ago } from "@milagre/shared/main-sync";
import { providerName } from "@milagre/shared/providers";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  TOKEN_CATEGORIES,
  TOKEN_CATEGORY_INK,
  TOKEN_USAGE_PROVIDERS,
  TOKEN_USAGE_PROVIDER_COLORS,
  TOKEN_USAGE_RANGES,
  cacheHitRate,
  calendarDayLabel,
  calendarLevels,
  calendarSummary,
  calendarWeeks,
  chatMeta,
  coveredDays,
  formatMetric,
  formatShare,
  formatTokenCount,
  formatUsd,
  metricOf,
  periodLabel,
  splitValue,
  tokenTotal,
  type TokenUsageDay,
  type TokenUsageDays,
  type TokenUsageMetric,
  type TokenUsageProject,
  type TokenUsageRange,
  type TokenUsageReport,
  type TokenUsageTotals,
} from "@milagre/shared/token-usage";
import type { ModelProvider } from "../../model";
import { bridgeFor } from "../../lib/computer-bridge";
import { useComputers } from "../../lib/computers";
import { ScrollArea } from "../primitives/ScrollArea";
import { Select } from "../primitives/Select";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ProviderLogo } from "../ProviderLogo";
import { AccountUsageSection } from "../usage/AccountUsageSection";

const PREFS_KEY = "milagre.tokenUsage";
// While a scan runs, the page reads again this often; a token-usage:changed event also reads at once.
const REFRESHING_POLL_MS = 2500;
// Chats a Project shows when opened, before "Show N more Chats".
const FIRST_CHATS = 5;
const card = "rounded-card bg-surface shadow-card";
// The calendar's shades: nothing, then the accent mixed in more strongly for each fifth of the busy days.
const SHADES = ["var(--hover-2)", ...[20, 38, 56, 76, 100].map((share) => `color-mix(in oklab, var(--accent) ${share}%, var(--surface))`)];
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

type Prefs = { metric: TokenUsageMetric; range: TokenUsageRange };

function readPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      metric: saved.metric === "tokens" ? "tokens" : "cost",
      range: TOKEN_USAGE_RANGES.some((range) => range.value === saved.range) ? saved.range : "7d",
    };
  } catch {
    return { metric: "cost", range: "7d" };
  }
}

/** One computer's report for a range or picked days, read again when its host says the numbers changed. */
function useTokenUsage(computerId: string, range: TokenUsageRange, days: TokenUsageDays | null) {
  const [report, setReport] = useState<TokenUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const from = days?.from;
  const to = days?.to;
  useEffect(() => {
    const bridge = bridgeFor(computerId);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const version = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      clearTimeout(timer);
      try {
        const next = await bridge.readTokenUsage({ range, timeZone, ...(from && to ? { days: { from, to } } : {}) });
        if (version !== generation.current) return;
        setReport(next);
        setError(null);
        if (next.refreshing) timer = setTimeout(() => void read(), REFRESHING_POLL_MS);
      } catch (failure) {
        if (version === generation.current) setError(ipcErrorMessage(failure));
      }
    };
    void read();
    // The computer's own token-usage:changed: a paired computer's bridge carries its events.
    const off = bridge.onTokenUsageChanged?.(() => void read());
    return () => {
      clearTimeout(timer);
      off?.();
    };
  }, [computerId, range, from, to]);
  return { report, error };
}

function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex rounded-control bg-hover p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={`h-7 rounded-chip px-3 text-12 font-medium transition-colors ${value === option.value ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A bar split by provider, in the fixed provider order, each part as long as its share of `whole`. */
function SplitBar({ values, whole, height = 8 }: { values: { provider: ModelProvider; value: number }[]; whole: number; height?: number }) {
  const shown = values.filter((entry) => entry.value > 0);
  const used = shown.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <span aria-hidden className="flex w-full gap-0.5" style={{ height }}>
      {shown.map((entry) => (
        <span
          key={entry.provider}
          className="h-full min-w-[3px] rounded-full"
          style={{ flexGrow: entry.value, flexBasis: 0, background: TOKEN_USAGE_PROVIDER_COLORS[entry.provider] }}
        />
      ))}
      {whole > used && <span className="h-full" style={{ flexGrow: whole - used, flexBasis: 0 }} />}
    </span>
  );
}

function TotalCard({ report, metric, onClear }: { report: TokenUsageReport; metric: TokenUsageMetric; onClear?: () => void }) {
  const { totals } = report;
  const providers = TOKEN_USAGE_PROVIDERS.filter((provider) => report.providers.some((entry) => entry.provider === provider));
  const value = (provider: ModelProvider) => {
    const entry = report.providers.find((item) => item.provider === provider);
    return entry ? metricOf(metric, entry.totals) : 0;
  };
  const whole = metricOf(metric, totals);
  return (
    <section className={`${card} flex flex-wrap items-center gap-x-12 gap-y-4 px-6 py-5`} aria-label="Total">
      <div className="min-w-[280px] flex-1">
        <p className="flex items-center gap-2 text-12 text-ink-3">
          {periodLabel(report)}
          {onClear && (
            <button
              type="button"
              data-token-usage-clear
              onClick={onClear}
              className="inline-flex h-5 items-center gap-1 rounded-full bg-hover px-2 text-11 font-medium text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink"
            >
              Clear
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          )}
        </p>
        <p className="mt-1 text-26 font-semibold tracking-[-0.02em] text-ink tabular-nums">{formatMetric(metric, whole)}</p>
        <p className="mt-1 text-13 text-ink-2">
          {metric === "cost" ? `${formatTokenCount(tokenTotal(totals))} tokens` : `${formatUsd(totals.costUsd)} at API prices`} ·{" "}
          {formatTokenCount(totals.requests)} requests
          {tokenTotal(totals) > 0 ? ` · ${Math.round(cacheHitRate(totals) * 100)}% from cache` : ""}
          {totals.unpricedTokens > 0 ? ` · ${formatTokenCount(totals.unpricedTokens)} tokens unpriced` : ""}
        </p>
      </div>
      {providers.length > 0 && (
        <div className="min-w-[280px] flex-1">
          <SplitBar values={providers.map((provider) => ({ provider, value: value(provider) }))} whole={whole} height={10} />
          <div className="mt-3 flex justify-between gap-4">
            {providers.map((provider, index) => {
              const entry = report.providers.find((item) => item.provider === provider)!;
              return (
                <div key={provider} className={index > 0 ? "text-right" : ""}>
                  <p className={`flex items-center gap-1.5 text-12 text-ink-2 ${index > 0 ? "justify-end" : ""}`}>
                    <span aria-hidden className="size-2 rounded-full" style={{ background: TOKEN_USAGE_PROVIDER_COLORS[provider] }} />
                    {providerName(provider)} · {formatShare(value(provider), whole)}
                  </p>
                  <p className="mt-0.5 text-13 font-medium text-ink tabular-nums">
                    {formatUsd(entry.totals.costUsd)} · {formatTokenCount(tokenTotal(entry.totals))} tokens
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The last 90 days as a calendar, a column per week. The report's days are at full strength; a click picks a day and a
 * drag picks a span, which the rest of the page then covers.
 */
function CalendarCard({ report, metric, onPick }: { report: TokenUsageReport; metric: TokenUsageMetric; onPick: (days: TokenUsageDays) => void }) {
  const weeks = useMemo(() => calendarWeeks(report.calendar), [report.calendar]);
  const levels = useMemo(() => calendarLevels(report.calendar, metric), [report.calendar, metric]);
  const covered = useMemo(() => coveredDays(report), [report]);
  const summary = calendarSummary(report.calendar, metric);
  const [drag, setDrag] = useState<TokenUsageDays | null>(null);
  const [hovered, setHovered] = useState<TokenUsageDay | null>(null);
  useEffect(() => {
    if (!drag) return;
    const finish = () => {
      onPick(drag.from <= drag.to ? drag : { from: drag.to, to: drag.from });
      setDrag(null);
    };
    window.addEventListener("pointerup", finish);
    return () => window.removeEventListener("pointerup", finish);
  }, [drag, onPick]);
  const inDrag = (key: string) =>
    Boolean(drag) && key >= (drag!.from < drag!.to ? drag!.from : drag!.to) && key <= (drag!.from < drag!.to ? drag!.to : drag!.from);
  const value = (day: TokenUsageDay) => (metric === "cost" ? day.costUsd : day.tokens);

  return (
    <section className={`${card} flex flex-wrap items-center gap-x-12 gap-y-4 px-6 py-5`} aria-label="Past 90 days">
      <div className="select-none">
        <p className="mb-2 pl-10 text-12 font-medium text-ink-2">Past 90 days</p>
        <div className="flex gap-1">
          <div className="flex w-9 flex-col gap-1 pt-[18px]">
            {WEEKDAYS.map((label, index) => (
              <span key={index} className="flex h-[22px] items-center text-11 text-ink-3">
                {label}
              </span>
            ))}
          </div>
          {weeks.map((week, column) => (
            <div key={column} className="flex flex-col gap-1">
              <span className="h-[14px] text-11 whitespace-nowrap text-ink-3">{week.month ?? ""}</span>
              {week.days.map((day, row) =>
                day ? (
                  <button
                    key={day.key}
                    type="button"
                    data-usage-day={day.key}
                    aria-label={`${calendarDayLabel(day)}: ${formatMetric(metric, value(day))}`}
                    aria-pressed={Boolean(report.days && covered.has(day.key))}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      setDrag({ from: day.key, to: day.key });
                    }}
                    onPointerEnter={() => {
                      setHovered(day);
                      if (drag) setDrag({ ...drag, to: day.key });
                    }}
                    onPointerLeave={() => setHovered((current) => (current?.key === day.key ? null : current))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onPick({ from: day.key, to: day.key });
                      }
                    }}
                    className="size-[22px] rounded-inline transition-opacity"
                    style={{
                      background: SHADES[levels.get(day.key) ?? 0],
                      opacity: drag ? (inDrag(day.key) ? 1 : 0.35) : covered.has(day.key) ? 1 : 0.35,
                    }}
                  />
                ) : (
                  <span key={`empty-${row}`} className="size-[22px]" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-[240px] flex-1">
        <p className="text-22 font-semibold tracking-[-0.02em] text-ink tabular-nums">{formatMetric(metric, summary.total)} in 90 days</p>
        <p className="mt-2 text-13 text-ink-2" data-usage-day-detail>
          {hovered
            ? `${calendarDayLabel(hovered)}: ${formatUsd(hovered.costUsd)} · ${formatTokenCount(hovered.tokens)} tokens`
            : `${summary.active} active ${summary.active === 1 ? "day" : "days"}${summary.busiest ? `. Busiest day ${summary.busiest.label} (${formatMetric(metric, summary.busiest.value)})` : ""}.`}
        </p>
        <p className="mt-1 text-12 text-ink-3">Click a day, or drag across days, to see only them.</p>
        <div className="mt-3 flex items-center gap-1 text-11 text-ink-3">
          Less
          {SHADES.map((shade) => (
            <span key={shade} aria-hidden className="size-3 rounded-inline" style={{ background: shade }} />
          ))}
          More
        </div>
      </div>
    </section>
  );
}

function ProjectRow({
  project,
  metric,
  whole,
  largest,
  now,
  open,
  onToggle,
  onOpenChat,
}: {
  project: TokenUsageProject;
  metric: TokenUsageMetric;
  whole: number;
  largest: number;
  now: number;
  open: boolean;
  onToggle: () => void;
  onOpenChat?: (projectPath: string, sessionId: number) => void;
}) {
  const [all, setAll] = useState(false);
  const value = metricOf(metric, project.totals);
  const chats = all ? project.chats : project.chats.slice(0, FIRST_CHATS);
  const hidden = project.chats.length - chats.length;
  const name = project.milagre ? project.name : `${project.name} · ${project.count} ${project.count === 1 ? "folder" : "folders"}`;
  const unit = (count: number) => (project.milagre ? (count === 1 ? "Chat" : "Chats") : count === 1 ? "folder" : "folders");
  return (
    <li data-usage-project={project.path || "outside"}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full flex-col gap-1.5 rounded-control px-2 py-2 text-left transition-colors hover:bg-hover"
      >
        <span className="flex w-full items-center gap-2">
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={14}
            strokeWidth={1.8}
            className={`shrink-0 text-ink-4 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className={`min-w-0 flex-1 truncate text-13 font-semibold ${project.milagre ? "text-ink" : "text-ink-2"}`}>{name}</span>
          <span className="shrink-0 text-12 text-ink-3 tabular-nums">{formatShare(value, whole)}</span>
          <span className="w-[72px] shrink-0 text-right text-13 font-semibold text-ink tabular-nums">{formatMetric(metric, value)}</span>
        </span>
        <span className="block pl-[22px]" style={{ width: `${Math.max(2, (value / Math.max(largest, 1)) * 100)}%` }}>
          <SplitBar values={TOKEN_USAGE_PROVIDERS.map((provider) => ({ provider, value: splitValue(metric, project.providers, provider) }))} whole={value} />
        </span>
      </button>
      {open && (
        <ul className="pb-2">
          {chats.map((chat, index) => {
            const canOpen = chat.kind === "chat" && chat.sessionId !== undefined && onOpenChat;
            const content = (
              <>
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: chat.providers[0] ? TOKEN_USAGE_PROVIDER_COLORS[chat.providers[0]] : undefined }}
                />
                <span className={`min-w-0 flex-1 truncate text-13 ${chat.kind === "chat" ? "text-ink" : "text-ink-2"}`}>{chat.title}</span>
                <span className="max-w-[40%] shrink-0 truncate text-11 text-ink-3">{chatMeta(chat, now)}</span>
                <span className="w-[72px] shrink-0 text-right text-13 text-ink tabular-nums">{formatMetric(metric, metricOf(metric, chat.totals))}</span>
              </>
            );
            const row = "flex h-8 w-full items-center gap-2 rounded-control pr-2 pl-[30px] text-left";
            return (
              <li key={chat.sessionId ?? `${chat.kind}-${index}`}>
                {canOpen ? (
                  <button
                    type="button"
                    data-usage-chat={chat.sessionId}
                    onClick={() => onOpenChat(project.path, chat.sessionId!)}
                    className={`${row} transition-colors hover:bg-hover`}
                  >
                    {content}
                  </button>
                ) : (
                  <div className={row}>{content}</div>
                )}
              </li>
            );
          })}
          {hidden > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setAll(true)}
                className="flex h-8 items-center rounded-control pr-2 pl-[44px] text-12 font-medium text-ink-3 transition-colors hover:text-ink"
              >
                Show {hidden} more {unit(hidden)}
              </button>
            </li>
          )}
          {all && project.more && (
            <li className="flex h-8 items-center gap-2 pr-2 pl-[44px] text-12 text-ink-3">
              <span className="flex-1">
                {project.more.count} smaller {unit(project.more.count)}
              </span>
              <span className="tabular-nums">{formatMetric(metric, metricOf(metric, project.more.totals))}</span>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function WhereItWent({
  report,
  metric,
  onOpenChat,
}: {
  report: TokenUsageReport;
  metric: TokenUsageMetric;
  onOpenChat?: (projectPath: string, sessionId: number) => void;
}) {
  const whole = metricOf(metric, report.totals);
  const largest = Math.max(0, ...report.projects.map((project) => metricOf(metric, project.totals)));
  const now = report.generatedAt;
  // The top Project starts open; a Project opened or closed by hand stays so as the numbers change.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  return (
    <section className={`${card} min-w-[420px] flex-1 p-4`} aria-label="Where it went">
      <div className="flex items-baseline justify-between gap-4 px-2 pb-2">
        <h2 className="text-15 font-semibold text-ink">Where it went</h2>
        <span className="text-12 text-ink-3">Projects and Chats, by {metric === "cost" ? "cost" : "tokens"}</span>
      </div>
      <ul>
        {report.projects.map((project, index) => (
          <ProjectRow
            key={project.path || "outside"}
            project={project}
            metric={metric}
            whole={whole}
            largest={largest}
            now={now}
            open={toggled[project.path || "outside"] ?? index === 0}
            onToggle={() => setToggled((current) => ({ ...current, [project.path || "outside"]: !(current[project.path || "outside"] ?? index === 0) }))}
            onOpenChat={onOpenChat}
          />
        ))}
      </ul>
      {report.moreProjects && (
        <p className="flex justify-between px-2 pt-2 text-12 text-ink-3">
          <span>
            {report.moreProjects.count} more {report.moreProjects.count === 1 ? "Project" : "Projects"}
          </span>
          <span className="tabular-nums">{formatMetric(metric, metricOf(metric, report.moreProjects.totals))}</span>
        </p>
      )}
    </section>
  );
}

function Models({ report, metric }: { report: TokenUsageReport; metric: TokenUsageMetric }) {
  const largest = Math.max(0, ...report.models.map((model) => metricOf(metric, model.totals)));
  return (
    <section className={`${card} p-4`} aria-label="Models">
      <h2 className="text-15 font-semibold text-ink">Models</h2>
      <ul className="mt-2 flex flex-col gap-2.5">
        {report.models.map((model) => (
          <li key={`${model.provider}:${model.model}`} data-usage-model={model.model}>
            <div className="flex items-center gap-2">
              <ProviderLogo provider={model.provider} size={12} />
              <span className="min-w-0 flex-1 truncate text-13 text-ink">{model.model}</span>
              <span className="shrink-0 text-11 text-ink-3 tabular-nums">{Math.round(cacheHitRate(model.totals) * 100)}% cached</span>
              <span className="w-[64px] shrink-0 text-right text-13 font-medium text-ink tabular-nums">
                {metric === "cost" && !model.priced ? (
                  <span className="font-normal text-ink-3">Unpriced</span>
                ) : (
                  formatMetric(metric, metricOf(metric, model.totals))
                )}
              </span>
            </div>
            <span
              aria-hidden
              className="mt-1.5 block h-1 rounded-full bg-hover-2"
              style={{ width: `${Math.max(1, (metricOf(metric, model.totals) / Math.max(largest, 1)) * 100)}%` }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

const inkOf = (share: number) => `color-mix(in oklab, var(--ink) ${share}%, var(--surface))`;

function TokenMix({ totals, metric }: { totals: TokenUsageTotals; metric: TokenUsageMetric }) {
  const value = (key: keyof TokenUsageTotals["cost"]) => (metric === "cost" ? totals.cost[key] : totals[key]);
  const order = [...TOKEN_CATEGORIES].sort((a, b) => TOKEN_CATEGORY_INK[a.key] - TOKEN_CATEGORY_INK[b.key]);
  return (
    <section className={`${card} p-4`} aria-label="Token mix">
      <h2 className="text-15 font-semibold text-ink">Token mix</h2>
      <div className="mt-3 flex h-2.5 gap-0.5">
        {order.map(({ key }) =>
          value(key) > 0 ? (
            <span
              key={key}
              className="h-full min-w-[3px] first:rounded-l-full last:rounded-r-full"
              style={{ flexGrow: value(key), flexBasis: 0, background: inkOf(TOKEN_CATEGORY_INK[key]) }}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {order.map(({ key, label }) => (
          <li key={key} className="flex items-center gap-2 text-12 text-ink-2">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: inkOf(TOKEN_CATEGORY_INK[key]) }} />
            <span className="flex-1">{label}</span>
            <span className="text-ink-3 tabular-nums">{formatTokenCount(totals[key])}</span>
            <span className="w-[64px] text-right text-ink tabular-nums">{formatUsd(totals.cost[key])}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-12 text-ink-3">
        {Math.round(cacheHitRate(totals) * 100)}% cache hit rate · cache reads saved about {formatUsd(totals.cacheSavingsUsd)}
        {totals.reasoning > 0 ? ` · ${formatTokenCount(totals.reasoning)} reasoning tokens` : ""}
      </p>
    </section>
  );
}

/**
 * The Usage page: the tokens Claude Code and Codex used on a computer and what they would cost on the API. The total
 * and its provider split, the last 90 days as a calendar that picks the days the page covers, then where it went:
 * Projects and their Chats, models and token categories.
 */
export function TokenUsagePage({
  onOpenChat,
  onManageAccounts,
}: {
  onOpenChat?: (computerId: string, projectPath: string, sessionId: number) => void;
  onManageAccounts?: () => void;
}) {
  const [prefs, setPrefs] = useState(readPrefs);
  const [days, setDays] = useState<TokenUsageDays | null>(null);
  const { thisMac, computers } = useComputers();
  const [computerId, setComputerId] = useState<string>(LOCAL_COMPUTER);
  const picked = computerId === LOCAL_COMPUTER || computers.some((computer) => computer.id === computerId) ? computerId : LOCAL_COMPUTER;
  const { report, error } = useTokenUsage(picked, prefs.range, days);
  const update = (patch: Partial<Prefs>) =>
    setPrefs((current) => {
      const next = { ...current, ...patch };
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  // Escape clears picked days before it leaves the page.
  useEffect(() => {
    if (!days) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setDays(null);
    };
    window.addEventListener("keydown", clear, true);
    return () => window.removeEventListener("keydown", clear, true);
  }, [days]);
  const { metric } = prefs;
  const empty = report && !report.refreshing && tokenTotal(report.totals) === 0;
  const computerName = picked === LOCAL_COMPUTER ? "this Mac" : (computers.find((computer) => computer.id === picked)?.name ?? "that computer");

  return (
    <ScrollArea className="flex h-full flex-col">
      <div data-token-usage-page className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col gap-4 px-6 pt-14 pb-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-22 font-semibold tracking-[-0.02em] text-ink">Usage</h1>
          <div className="flex flex-wrap items-center gap-2">
            {computers.length > 0 && (
              <Select
                label="Computer"
                value={picked}
                width={200}
                compact
                options={[
                  { value: LOCAL_COMPUTER, label: thisMac || "This Mac" },
                  ...computers.map((computer) => ({ value: computer.id, label: computer.name })),
                ]}
                onChange={(value) => {
                  setComputerId(value);
                  setDays(null);
                }}
              />
            )}
            <Tabs
              label="Show"
              value={metric}
              options={[
                { value: "cost", label: "Cost" },
                { value: "tokens", label: "Tokens" },
              ]}
              onChange={(value) => update({ metric: value })}
            />
            <Tabs
              label="Period"
              value={days ? null : prefs.range}
              options={TOKEN_USAGE_RANGES.map((range) => ({ value: range.value, label: range.short }))}
              onChange={(value) => {
                setDays(null);
                update({ range: value });
              }}
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="text-13 break-words text-red-ink">
            Couldn't read token usage: {error}
          </p>
        )}
        {report?.refreshing && (
          <p data-token-usage-refreshing className="flex items-center gap-2 text-12 text-ink-3">
            <SpinnerRing size={12} />
            {report.firstScan ? "Reading the Claude Code and Codex transcripts for the first time. This can take a minute…" : "Reading new transcripts…"}
          </p>
        )}
        {report && report.pricing.status !== "ok" && (
          <p className="text-12 text-ink-3">
            {report.pricing.status === "loading"
              ? "Loading model prices…"
              : report.pricing.status === "stale"
                ? "Model prices couldn't be refreshed; costs use the last list."
                : "Model prices couldn't be loaded, so costs show $0 until they are."}
          </p>
        )}
        {!report && !error && (
          <p className="flex items-center gap-2 text-13 text-ink-3">
            <SpinnerRing size={14} /> Loading usage…
          </p>
        )}

        <AccountUsageSection
          key={picked}
          computerId={picked}
          computerName={picked === LOCAL_COMPUTER ? thisMac || "this Mac" : computerName}
          onManageAccounts={onManageAccounts}
        />
        {report && (
          <>
            <TotalCard report={report} metric={metric} onClear={days ? () => setDays(null) : undefined} />
            <CalendarCard report={report} metric={metric} onPick={setDays} />
            {empty ? (
              <section className={`${card} px-4 py-10 text-center`}>
                <p className="text-13 font-medium text-ink">No usage in this period</p>
                <p className="mt-1 text-12 text-ink-3">Claude Code and Codex sessions on {computerName} show here as they run.</p>
              </section>
            ) : (
              <div className="flex flex-wrap items-start gap-4">
                <WhereItWent report={report} metric={metric} onOpenChat={onOpenChat ? (path, id) => onOpenChat(picked, path, id) : undefined} />
                <div className="flex w-full flex-col gap-4 lg:w-[360px]">
                  <Models report={report} metric={metric} />
                  <TokenMix totals={report.totals} metric={metric} />
                </div>
              </div>
            )}
            <p className="text-11 text-ink-3">
              Read from the Claude Code and Codex transcripts on {computerName}, including sessions run outside Milagre. Costs are estimates at API prices from
              LiteLLM's model list{report.pricing.fetchedAt ? ` (updated ${ago(Date.parse(report.pricing.fetchedAt), report.generatedAt)})` : ""}, not your
              plan's bill. Kiro and Antigravity aren't counted.
            </p>
          </>
        )}
      </div>
    </ScrollArea>
  );
}
