// Mounts the canvas section's React Flow island. Loaded only when the section nears the viewport, so React and React
// Flow stay out of the page's first load.
import { createRoot } from "react-dom/client";
import LiveCanvas from "../components/LiveCanvas";

export function mountCanvas(host: HTMLElement) {
  createRoot(host).render(<LiveCanvas />);
}
