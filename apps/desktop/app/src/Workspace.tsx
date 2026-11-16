import App from "./App";
import { BrowserPages } from "./components/agents/BrowserPanel";
import { AppMotionConfig } from "./components/motion/AppMotionConfig";

export default function Workspace() {
  return (
    <AppMotionConfig>
      <App />
      <BrowserPages />
    </AppMotionConfig>
  );
}
