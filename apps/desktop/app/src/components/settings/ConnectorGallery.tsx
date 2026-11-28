import { CommandLineIcon, Key01Icon, Login03Icon, PackageIcon, Search01Icon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { CONNECTOR_CATEGORIES, connectorSignInLabel, searchConnectorPresets, type ConnectorCategory, type ConnectorPreset } from "@milagre/shared/connectors";
import { Icon } from "../primitives/Icon";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import { ConnectorTile } from "./ConnectorTile";
import { field } from "./ConnectorFields";

const SIGN_IN_ICON = { browser: Login03Icon, token: Key01Icon, app: PackageIcon, email: SquareLock02Icon, command: CommandLineIcon } as const;

/** The tile text for the two built-ins, which do more than their MCP description says. */
const BUILT_IN_COPY: Record<string, string> = {
  email: "Agents read sign-in codes and links from your inbox. Read-only.",
  linear: "Start Chats from issues, show issues on Worktrees and give agents Linear tools.",
};

function Tile({ preset, added, onChoose }: { preset: ConnectorPreset; added: boolean; onChoose: (preset: ConnectorPreset) => void }) {
  const builtIn = preset.category === "builtin";
  return (
    <button
      type="button"
      data-connector-service={preset.id}
      onClick={() => onChoose(preset)}
      className={`flex flex-col gap-2.5 rounded-card border border-line-strong bg-surface p-3.5 text-left transition-colors hover:bg-hover active:bg-hover-2 ${builtIn ? "min-h-31" : "min-h-27"}`}
    >
      <span className="flex items-center gap-2.5">
        <ConnectorTile iconPath={preset.iconPath} letter={preset.name} mail={preset.auth === "email"} command={preset.auth === "command" && !preset.iconPath} />
        <span className="min-w-0 flex-1 truncate text-13 font-semibold text-ink">{preset.name}</span>
        {added ? (
          <span data-connector-added className="shrink-0 rounded-chip bg-green-tint px-1.5 text-10 leading-4.5 font-semibold text-green-ink">
            Added
          </span>
        ) : (
          builtIn && <span className="shrink-0 rounded-chip bg-field px-1.5 text-10 leading-4.5 font-semibold text-ink-2">Milagre</span>
        )}
      </span>
      <span className="line-clamp-2 flex-1 text-12 text-ink-2">{BUILT_IN_COPY[preset.id] ?? preset.description}</span>
      <span className="flex items-center gap-1.5 text-11 text-ink-3">
        <Icon icon={SIGN_IN_ICON[preset.auth]} size={12} className="text-ink-4" />
        {connectorSignInLabel(preset)}
      </span>
    </button>
  );
}

/** Add connector's catalog: search, then the chosen category's services as tiles, the built-ins first. */
export function ConnectorGallery({
  query,
  onQuery,
  category,
  added,
  onChoose,
  onCustom,
}: {
  query: string;
  onQuery: (query: string) => void;
  category: ConnectorCategory | null;
  /** Preset ids already added on this computer. */
  added: ReadonlySet<string>;
  onChoose: (preset: ConnectorPreset) => void;
  onCustom: () => void;
}) {
  const found = searchConnectorPresets(query, category ?? undefined);
  const sections = CONNECTOR_CATEGORIES.map((section) => ({ ...section, presets: found.filter((preset) => preset.category === section.id) })).filter(
    (section) => section.presets.length > 0,
  );
  return (
    <div data-connector-catalog className="flex min-h-0 flex-1 flex-col">
      <label className="relative mx-5 mt-4 mb-3 block">
        <Icon icon={Search01Icon} size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
        <input
          autoFocus
          aria-label="Search services"
          placeholder={`Search ${searchConnectorPresets("").length} services`}
          className={`${field} pl-9`}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <ScrollArea className="min-h-0 flex-1 space-y-5 px-5 pb-5">
        {sections.map((section) => (
          <section key={section.id} data-connector-section={section.id}>
            <SectionLabel as="h3" className="pb-1.5">
              {section.id === "builtin" ? "Built into Milagre" : section.label}
            </SectionLabel>
            <div className={`grid gap-2.5 ${section.id === "builtin" ? "grid-cols-2" : "grid-cols-3"}`}>
              {section.presets.map((preset) => (
                <Tile key={preset.id} preset={preset} added={added.has(preset.id)} onChoose={onChoose} />
              ))}
            </div>
          </section>
        ))}
        {sections.length === 0 && (
          <p role="status" className="py-10 text-center text-13 text-ink-2">
            Nothing matches "{query}".{" "}
            <button type="button" className="font-medium text-accent-ink hover:underline" onClick={onCustom}>
              Add a custom connector
            </button>
          </p>
        )}
      </ScrollArea>
    </div>
  );
}
