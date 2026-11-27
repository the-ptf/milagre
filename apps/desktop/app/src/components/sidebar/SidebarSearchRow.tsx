import type { ReactNode } from "react";
import { Cancel01Icon, FolderAddIcon, PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { CHATS_GROUP_LABEL } from "@milagre/shared/chats-home";
import Tooltip from "@/components/primitives/Tooltip";
import { IconButton } from "../primitives/Button";
import { FieldGroup } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { useSidebarKeys } from "./use-sidebar-keys";
import { FlatChatList, type FlatScope } from "./ChatLists";
import type { SidebarRecent } from "./ChatRow";
import type { ChatOrder } from "../../lib/chat-list";
import { searchSidebarChats } from "../../lib/sidebar-search";

type Rows = { pinned: SidebarRecent[]; rest: SidebarRecent[] };

export function AddProjectButton({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const keys = useSidebarKeys();
  return (
    <Tooltip label="Add Project" shortcut={keys.addProject} side={collapsed ? "top" : "bottom"}>
      <IconButton size={32} label="Add Project" icon={FolderAddIcon} onClick={onClick} />
    </Tooltip>
  );
}

export function SidebarSearchResults({
  needle,
  homes,
  groups,
  order,
  scopes,
}: {
  needle: string;
  homes: (Rows & { key: string; offline: boolean })[];
  groups: (Rows & { scope: { key: string; name: string }; dimmed: boolean })[];
  order: ChatOrder;
  scopes: Map<string, FlatScope>;
}) {
  const chats = searchSidebarChats(
    needle,
    [
      ...homes.map(({ key, pinned, rest, offline }) => ({ key, name: CHATS_GROUP_LABEL, rows: [...pinned, ...rest], offline })),
      ...groups.map(({ scope, pinned, rest, dimmed }) => ({ key: scope.key, name: scope.name, rows: [...pinned, ...rest], offline: dimmed })),
    ],
    order,
  );
  if (chats.length) return <FlatChatList chats={chats} scopes={scopes} />;
  return (
    <p data-sidebar-search-empty className="mx-2 h-8 pl-2 text-[length:calc(13px+var(--sidebar-delta))] leading-8 text-ink-3">
      No Chats match your search.
    </p>
  );
}

export function SidebarSearchRow({
  collapsed,
  query,
  onQuery,
  filters,
  addProject,
  onNewChat,
}: {
  collapsed: boolean;
  query: string;
  onQuery: (query: string) => void;
  filters: ReactNode;
  addProject: ReactNode;
  onNewChat: () => void;
}) {
  const keys = useSidebarKeys();
  if (collapsed) return null;
  return (
    <div data-sidebar-search className="sidebar-copy mx-2 mb-1 flex h-9 shrink-0 items-center gap-0.5">
      <FieldGroup
        size={32}
        fill="bare"
        type="search"
        aria-label="Search Chats"
        placeholder="Search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (query) onQuery("");
          else event.currentTarget.blur();
        }}
        className="min-w-0 flex-1 pl-2 hover:bg-hover"
        inputClassName="text-[length:calc(13px+var(--sidebar-delta))] [&::-webkit-search-cancel-button]:hidden"
        leading={<Icon icon={Search01Icon} size={16} className="shrink-0 text-ink-3" />}
        trailing={
          query ? (
            <button type="button" aria-label="Clear search" onClick={() => onQuery("")} className="flex shrink-0 text-ink-3 hover:text-ink">
              <Icon icon={Cancel01Icon} size={14} />
            </button>
          ) : null
        }
      />
      {filters}
      {addProject}
      <Tooltip label="New chat" shortcut={keys.newChat} align="end">
        <IconButton size={32} label="New chat" icon={PencilEdit02Icon} onClick={onNewChat} />
      </Tooltip>
    </div>
  );
}
