import App from "./App";
import { BrowserPages } from "./components/agents/BrowserPanel";
import { DesignLibraryHost } from "./components/design-library/DesignLibraryHost";
import { AppMotionConfig } from "./components/motion/AppMotionConfig";

export default function Workspace() {
  return (
    <AppMotionConfig>
      <App />
      <BrowserPages />
      <DesignLibraryHost />
    </AppMotionConfig>
  );
}
