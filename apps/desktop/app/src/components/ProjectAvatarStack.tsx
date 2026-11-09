import { useProjectImages } from "../lib/project-images";
import { ProjectAvatar } from "./primitives/ProjectAvatar";
export function ProjectAvatarStack({ projects }: { projects: Array<{ path: string; name: string }> }) {
  const imageOf = useProjectImages(projects.map((project) => project.path));
  const stacked = projects.length > 1;
  return (
    <span aria-hidden className={`flex shrink-0 items-center ${stacked ? "pr-1" : ""}`}>
      {projects.slice(0, 3).map((project, index) => (
        <span key={project.path || index} className="relative flex" style={{ marginLeft: index ? -8 : 0, zIndex: 3 - index }}>
          <ProjectAvatar name={project.name} src={imageOf(project.path)} size={stacked ? 20 : 24} className={stacked ? "ring-2 ring-surface" : ""} />
        </span>
      ))}
    </span>
  );
}
