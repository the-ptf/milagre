import { useEffect, useState } from "react";
import { normalizeSidebarSettings, SIDEBAR_DEFAULTS, SIDEBAR_PROJECT_OPTIONS } from "@milagre/shared/sidebar-settings";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";

/** Host-kept: how many recent Projects this computer lists in the sidebar, on desktop and phone. */
export function SidebarProjectsSetting() {
  const [projects, setProjects] = useState(SIDEBAR_DEFAULTS.projects);
  useEffect(() => {
    let live = true;
    const show = (value: unknown) => live && setProjects(normalizeSidebarSettings(value).projects);
    void window.milagre
      .readSidebarSettings?.()
      .then(show)
      .catch(() => {});
    const off = window.milagre.onSidebarSettings?.(show);
    return () => {
      live = false;
      off?.();
    };
  }, []);
  const choose = (next: number) => {
    const previous = projects;
    setProjects(next);
    void window.milagre
      .saveSidebarSettings({ projects: next })
      .then((value) => setProjects(normalizeSidebarSettings(value).projects))
      .catch(() => setProjects(previous));
  };
  return (
    <Group title="Sidebar">
      <Row label="Projects shown" description="The most recently opened Projects the sidebar lists">
        <Select
          label="Projects shown"
          width={140}
          value={String(projects)}
          options={SIDEBAR_PROJECT_OPTIONS.map((count) => ({ value: String(count), label: String(count) }))}
          onChange={(value) => choose(Number(value))}
        />
      </Row>
    </Group>
  );
}
