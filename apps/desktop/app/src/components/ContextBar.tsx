import { CONTEXT_GRADIENT, type ContextSettings } from "@milagre/shared/context-settings";
export function ContextBar({ percent = 100, settings, editable = false }: { percent?: number; settings: ContextSettings; editable?: boolean }) {
  const close = settings.autoThreshold - settings.buttonThreshold < 12;
  return (
    <div
      className={`relative w-full ${close ? "h-16" : "h-12"}`}
      data-context-bar
      role="img"
      aria-label={`Context ${Math.round(percent)}% used; Compact at ${settings.buttonThreshold}%; automatic at ${settings.autoThreshold}%`}
    >
      <div className="absolute inset-x-0 top-7 h-1.5 overflow-hidden rounded-full bg-line-strong">
        <div
          className="absolute inset-0 rounded-full"
          style={{ background: CONTEXT_GRADIENT, clipPath: `inset(0 ${100 - Math.max(0, Math.min(100, percent))}% 0 0 round 3px)` }}
        />
      </div>
      {(["buttonThreshold", "autoThreshold"] as const).map((key) => (
        <div key={key} className="absolute top-0 -translate-x-1/2" style={{ left: `${settings[key]}%` }}>
          <span
            style={close && key === "autoThreshold" ? { transform: "translateY(38px)" } : undefined}
            className={`block text-center text-11 tabular-nums font-medium ${key === "buttonThreshold" ? "text-orange-ink" : "text-ink"}`}
          >
            {settings[key]}%
          </span>
          {!editable && (
            <span
              className={`mx-auto mt-1.5 block size-4 rounded-full border-[2.5px] bg-surface ${key === "buttonThreshold" ? "border-orange" : "border-ink"}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
