import { createRoot } from "react-dom/client";
import LiveCanvas from "../components/LiveCanvas";

export function mountCanvas(host: HTMLElement) {
  createRoot(host).render(<LiveCanvas />);
}
