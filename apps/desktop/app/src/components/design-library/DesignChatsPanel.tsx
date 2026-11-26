import { useMemo, useState } from "react";
import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import { designSvg } from "@milagre/shared/design";
import {
  DESIGNS_COPY,
  filterDesignChats,
  isInteractiveDesign,
  libraryPagesBySource,
  type ArtifactSummary,
  type DesignLibrary,
  type DesignLibraryChat,
} from "@milagre/shared/artifact";
import { requestFromDesigns } from "../../lib/design-library-page";
import { showToast } from "../../lib/toast";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { FIELD } from "../primitives/Field";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import { useArtifact } from "../agents/artifact-read";
import { AddToLibraryDialog } from "../agents/AddToLibraryDialog";
import { useDesignChats } from "./design-home";

type Adding = { chatId: string; design: ArtifactSummary };

/** The Designs page's Chats section: every Chat's designs, read only, each one a step from the Project library. */
export function DesignChatsPanel({ projectKey, library }: { projectKey: string; library: DesignLibrary | null }) {
  const { value, error, retry } = useDesignChats(projectKey);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<Adding | null>(null);
  const inLibrary = useMemo(() => libraryPagesBySource(library), [library]);
  const chats = useMemo(() => filterDesignChats(value ?? [], query), [value, query]);
  if (!value && error) return <EmptyState title="Couldn't load the Chats' designs." size="page" action={<Button onClick={retry}>Try again</Button>} />;
  if (!value) return <div aria-busy="true" aria-label="Loading the Chats' designs" className="m-6 h-64 flex-1 animate-pulse rounded-card bg-hover" />;
  if (!value.length)
    return (
      <EmptyState icon={BubbleChatIcon} title={DESIGNS_COPY.noChatsTitle} size="page" data-slot="design-chats-empty">
        {DESIGNS_COPY.noChatsBody}
      </EmptyState>
    );
  const open = chats.filter((chat) => !chat.archived);
  const archived = chats.filter((chat) => chat.archived);
  return (
    <ScrollArea data-slot="design-chats" className="min-h-0 flex-1" aria-label="Chats' designs">
      <div className="flex flex-col gap-6 p-6">
        <input
          aria-label="Search designs"
          placeholder="Search designs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={`${FIELD} max-w-60`}
        />
        {!chats.length && <p className="text-13 text-ink-2">{DESIGNS_COPY.noMatch(query.trim())}</p>}
        {open.map((chat) => (
          <ChatDesigns key={chat.chatId} chat={chat} inLibrary={inLibrary} onAdd={(design) => setAdding({ chatId: chat.chatId, design })} />
        ))}
        {archived.length > 0 && <SectionLabel as="h2">{DESIGNS_COPY.archived}</SectionLabel>}
        {archived.map((chat) => (
          <ChatDesigns key={chat.chatId} chat={chat} inLibrary={inLibrary} onAdd={(design) => setAdding({ chatId: chat.chatId, design })} />
        ))}
      </div>
      {adding && (
        <AddToLibraryDialog
          chatId={adding.chatId}
          pages={library?.pages ?? []}
          source={{ designId: adding.design.id, title: adding.design.title }}
          onClose={() => setAdding(null)}
          onAdded={(entry) => {
            setAdding(null);
            showToast(`Added to ${library?.pages.find((page) => page.id === entry.page)?.name ?? "the library"}`);
          }}
        />
      )}
    </ScrollArea>
  );
}

function ChatDesigns({ chat, inLibrary, onAdd }: { chat: DesignLibraryChat; inLibrary: Map<string, string>; onAdd: (design: ArtifactSummary) => void }) {
  return (
    <section data-slot="design-chat" data-chat-id={chat.chatId} aria-label={chat.title} className="flex flex-col gap-2.5">
      <header className="flex items-center gap-2">
        <h3 className="min-w-0 truncate text-13 font-medium text-ink" title={chat.title}>
          {chat.title}
        </h3>
        <Button variant="link" size={24} className="ml-auto shrink-0" onClick={() => requestFromDesigns({ chatId: chat.chatId })}>
          {DESIGNS_COPY.openChat}
        </Button>
      </header>
      <ul className="flex flex-wrap gap-4">
        {chat.designs.map((design) => {
          const page = inLibrary.get(`${chat.chatId}\n${design.id}`);
          return (
            <li key={design.id} data-slot="design-chat-design" className="flex w-36 flex-col">
              <Thumbnail chatId={chat.chatId} design={design} />
              <span className="mt-1.5 truncate text-12 font-medium text-ink" title={design.title}>
                {design.title}
              </span>
              <span className="text-11 text-ink-3">v{design.version}</span>
              {page ? (
                <span className="mt-1 text-12 text-ink-3">{DESIGNS_COPY.inLibrary(page)}</span>
              ) : (
                <Button variant="secondary" size={24} className="mt-1 self-start" onClick={() => onAdd(design)}>
                  {DESIGNS_COPY.addToLibrary}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Thumbnail({ chatId, design }: { chatId: string; design: ArtifactSummary }) {
  const { artifact } = useArtifact(chatId, design.id, design.version);
  const source = useMemo(() => {
    const document = artifact && "document" in artifact ? artifact.document : undefined;
    return document ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(designSvg(document, { embedFonts: false }))}` : "";
  }, [artifact]);
  const ratio = design.height / Math.max(1, design.width);
  return (
    <div className="flex w-36 items-center justify-center overflow-hidden rounded-card bg-paper" style={{ height: Math.min(240, Math.round(144 * ratio)) }}>
      {source ? (
        <img src={source} alt="" className="size-full object-contain" />
      ) : (
        <span className="text-11 text-ink-3">{isInteractiveDesign(design) ? "Interactive" : ""}</span>
      )}
    </div>
  );
}
