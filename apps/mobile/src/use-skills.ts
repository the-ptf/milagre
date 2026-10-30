import type { SkillCatalog } from "@milagre/shared/model";
import { useSession } from "./session";
import { useRpc } from "./use-rpc";
import { useTheme } from "./theme";
import { lineHeight, radius, space, type } from "./design-tokens";

/** The open Project's skill catalog, or the user's skills only when no Project is open. */
export function useSkillCatalog() {
  const { client, snapshot } = useSession();
  const projectPath = snapshot?.project.path ?? null;
  return { projectPath, ...useRpc<SkillCatalog>(client, "skills:list", [projectPath]), connected: !!client };
}

/** The small pill beside a skill's name: a neutral Tag (24 tall, caption1 500, field fill, ink2). */
export function useSkillBadge() {
  const { colors } = useTheme();
  return {
    color: colors.ink2,
    fontSize: type.caption1,
    lineHeight: lineHeight.caption1,
    fontWeight: "500",
    backgroundColor: colors.field,
    borderRadius: radius.full,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    overflow: "hidden",
  } as const;
}
export const overrides = (count: number) => `Overrides ${count} other${count === 1 ? "" : "s"}`;
