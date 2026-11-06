import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BootSplash } from "./components/StartupSplash";
import "./fonts.css";
import "./styles.css";
import { applyThemeNow } from "./lib/settings";
import { followDisplayVisibility } from "./lib/display-clock";
import { splashDrawnFirst } from "./lib/startup-splash";

applyThemeNow();
followDisplayVisibility();
const floatingView = new URLSearchParams(window.location.search).get("floating-inbox");
const floating = floatingView === "dock" || floatingView === "inbox" || floatingView === "preview" || floatingView === "drag";
document.documentElement.toggleAttribute("data-floating-inbox", floating);
// A floating inbox window loads none of the app itself.
const FloatingInbox = lazy(() => import("./components/FloatingInbox").then((module) => ({ default: module.FloatingInbox })));
const FloatingMotion = lazy(() => import("./components/motion/AppMotionConfig").then((module) => ({ default: module.AppMotionConfig })));
splashDrawnFirst();

// Evaluating the app holds the main thread for a while, so the splash gets its first frame before that starts.
// A window off screen draws no frames, hence the timeout.
const afterFirstFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve));
    setTimeout(resolve, 50);
  });
const Workspace = lazy(() => afterFirstFrame().then(() => import("./Workspace")));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {floating ? (
      <Suspense fallback={null}>
        <FloatingMotion>
          <FloatingInbox view={floatingView} />
        </FloatingMotion>
      </Suspense>
    ) : (
      <>
        <Suspense fallback={null}>
          <Workspace />
        </Suspense>
        <BootSplash />
      </>
    )}
  </StrictMode>,
);
