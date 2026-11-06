import App from "./App";
import { BrowserPages } from "./components/agents/BrowserPanel";
import { AppMotionConfig } from "./components/motion/AppMotionConfig";

/** The whole app, in a chunk of its own so the splash paints first (main.tsx). */
export default function Workspace() {
  return (
    <AppMotionConfig>
      <App />
      <BrowserPages />
    </AppMotionConfig>
  );
}
