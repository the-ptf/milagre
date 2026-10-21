import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./fonts.css";
import "./styles.css";
import { AppMotionConfig } from "./components/motion/AppMotionConfig";
import { applyThemeNow } from "./lib/settings";
import { followDisplayVisibility } from "./lib/display-clock";

applyThemeNow();
followDisplayVisibility();
const floatingView = new URLSearchParams(window.location.search).get("floating-inbox");
const floating = floatingView === "dock" || floatingView === "inbox" || floatingView === "preview" || floatingView === "drag";
document.documentElement.toggleAttribute("data-floating-inbox", floating);
const FloatingInbox = lazy(() => import("./components/FloatingInbox").then((module) => ({ default: module.FloatingInbox })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppMotionConfig>
      {floating ? (
        <Suspense fallback={null}>
          <FloatingInbox view={floatingView} />
        </Suspense>
      ) : (
        <App />
      )}
    </AppMotionConfig>
  </StrictMode>,
);
