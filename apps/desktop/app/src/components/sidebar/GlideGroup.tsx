import { type ReactNode } from "react";
import GlideMenu from "@/components/primitives/GlideMenu";

export function GlideGroup({ children }: { children: ReactNode }) {
  return (
    <GlideMenu rowSelector="[data-row]" highlightClassName="sidebar-glide-highlight rounded-control bg-hover" className="group/glide flex flex-col gap-px">
      {children}
    </GlideMenu>
  );
}
