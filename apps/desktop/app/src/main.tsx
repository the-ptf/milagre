import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyThemeNow } from "./lib/settings";

applyThemeNow();
const floatingView = new URLSearchParams(window.location.search).get("floating-inbox");
const floating = floatingView === "dock" || floatingView === "inbox" || floatingView === "preview" || floatingView === "drag";
document.documentElement.toggleAttribute("data-floating-inbox", floating);
const FloatingInbox = lazy(() => import("./components/FloatingInbox").then((module) => ({ default: module.FloatingInbox })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {floating ? (
      <Suspense fallback={null}>
        <FloatingInbox view={floatingView} />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
