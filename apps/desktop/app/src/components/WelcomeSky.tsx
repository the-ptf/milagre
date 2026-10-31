import type { CSSProperties } from "react";

/** The logo's sparkle, cut out of the splash mark. */
const STAR =
  "M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z";

/** Where each sparkle catches the light (percent of the pane), its size and its beat. Long cycles, short flashes and
 * spread-out delays keep one or two lit at a time. */
const SPARKLES: { x: number; y: number; size: number; duration: number; delay: number }[] = [
  { x: 18, y: 14, size: 10, duration: 9, delay: 0.5 },
  { x: 31, y: 32, size: 8, duration: 10, delay: 3.4 },
  { x: 44, y: 9, size: 12, duration: 10, delay: 6.5 },
  { x: 58, y: 24, size: 9, duration: 11, delay: 1.9 },
  { x: 69, y: 11, size: 11, duration: 8, delay: 5 },
  { x: 80, y: 30, size: 8, duration: 12, delay: 8.4 },
  { x: 24, y: 40, size: 8, duration: 13, delay: 10.2 },
  { x: 75, y: 42, size: 9, duration: 10, delay: 1.4 },
];

/** Behind a new Chat: a faint wash of light from above and the logo's sparkle glinting here and there. Decoration only. */
export function WelcomeSky() {
  return (
    <div aria-hidden className="welcome-sky pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="welcome-sky-wash" />
      {SPARKLES.map((sparkle) => (
        <svg
          key={`${sparkle.x}-${sparkle.y}`}
          className="welcome-sky-sparkle"
          viewBox="26 -1 94 94"
          width={sparkle.size}
          height={sparkle.size}
          style={
            {
              left: `${sparkle.x}%`,
              top: `${sparkle.y}%`,
              animationDuration: `${sparkle.duration}s`,
              animationDelay: `${sparkle.delay}s`,
            } as CSSProperties
          }
        >
          <path d={STAR} />
        </svg>
      ))}
    </div>
  );
}
