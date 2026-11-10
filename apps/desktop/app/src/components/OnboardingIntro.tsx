import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSplash } from "../lib/startup-splash";

/** The logo's three shapes, as StartupSplash draws them. */
const MARK_LEFT =
  "M49.6983 66.5562L21.6836 116.174C19.802 119.507 22.2098 123.632 26.0372 123.632H39.9727L54.9727 100.132L66.9727 119.632L51.9727 144.132H26.0372C6.24066 144.132 -6.29344 122.89 3.27837 105.561L30.9405 55.4819L49.6983 66.5562Z";
const MARK_RIGHT =
  "M142.666 105.561C152.238 122.89 139.704 144.132 119.907 144.132H93.9728L78.9728 119.632L90.9728 100.132L105.973 123.632H119.907C123.735 123.632 126.143 119.507 124.261 116.174L96.2462 66.5562L115.004 55.4819L142.666 105.561Z";
const MARK_STAR =
  "M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z";

/** The same scene every time: a seeded generator, so the stars and clouds don't jump between renders. */
function seeded(seed: number) {
  return () => {
    seed = (Math.imul(seed ^ (seed >>> 15), seed | 1) + 0x6d2b79f5) | 0;
    return (seed >>> 0) / 4294967296;
  };
}

// Clouds are drawn once on a 1280 × 800 sky and stretched to the window: they are soft enough not to show it.
const SKY_W = 1280;
const SKY_H = 800;

/** A bank of clouds: overlapping ellipses roughened by noise (the filters in CloudFilters), shaded underneath. */
function CloudBank({
  seed,
  count,
  top,
  bottom,
  shade,
  filter,
  className,
}: {
  seed: number;
  count: number;
  top: number;
  bottom: number;
  shade: string;
  filter: string;
  className?: string;
}) {
  const blobs = useMemo(() => {
    const random = seeded(seed);
    return Array.from({ length: count }, (_, index) => {
      const x = (index / (count - 1)) * SKY_W * 1.2 - SKY_W * 0.1 + (random() - 0.5) * SKY_W * 0.08;
      const y = top + (bottom - top) * random();
      const rx = SKY_W * 0.09 + random() * SKY_W * 0.12;
      const ry = rx * (0.42 + random() * 0.2);
      return { id: `${x.toFixed(1)}:${y.toFixed(1)}`, x, y, rx, ry };
    });
  }, [seed, count, top, bottom]);
  return (
    <svg className={`onboarding-layer ${className ?? ""}`} viewBox={`0 0 ${SKY_W} ${SKY_H}`} preserveAspectRatio="none" aria-hidden>
      <g filter={`url(#${filter})`}>
        <g style={{ fill: shade }}>
          {blobs.map((blob) => (
            <ellipse key={blob.id} cx={blob.x} cy={blob.y + blob.ry * 0.35} rx={blob.rx} ry={blob.ry} />
          ))}
        </g>
        <g className="onboarding-cloud-face">
          {blobs.map((blob) => (
            <ellipse key={blob.id} cx={blob.x - blob.rx * 0.08} cy={blob.y} rx={blob.rx * 0.92} ry={blob.ry * 0.9} />
          ))}
        </g>
        <rect className="onboarding-cloud-face" x={-50} y={bottom} width={SKY_W + 100} height={SKY_H * 2} />
      </g>
    </svg>
  );
}

/** The noise that turns ellipses into clouds; rendered once per screen that draws clouds. */
function CloudFilters() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        <filter id="onboarding-cloudy" x="-50%" y="-80%" width="200%" height="260%">
          <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves={4} seed={7} result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale={70} xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation={5} />
        </filter>
        <filter id="onboarding-cloudy-soft" x="-50%" y="-80%" width="200%" height="260%">
          <feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves={3} seed={3} result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale={90} xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation={14} />
        </filter>
      </defs>
    </svg>
  );
}

function Stars() {
  const stars = useMemo(() => {
    const random = seeded(11);
    return Array.from({ length: 140 }, (_, index) => ({
      id: index,
      left: random() * 100,
      top: random() * 70,
      size: random() * 1.8 + 0.6,
      opacity: 0.35 + random() * 0.6,
    }));
  }, []);
  return (
    <div className="onboarding-layer onboarding-intro-stars" aria-hidden>
      {stars.map((star) => (
        <i key={star.id} style={{ left: `${star.left}%`, top: `${star.top}%`, width: star.size, height: star.size, opacity: star.opacity }} />
      ))}
    </div>
  );
}

/** Where the falling star starts, as a share of the window, and the angle its tail trails at. */
const FALL_FROM = { x: 0.34, y: -0.62 };
function tailAngle() {
  return -(Math.atan2(-FALL_FROM.y * window.innerHeight, FALL_FROM.x * window.innerWidth) * 180) / Math.PI;
}

/**
 * The first-launch intro, "Dawn": a night sky, a falling star that lands where the logo's sparkle sits, the legs rising
 * under it with the loading mark's own motion, and dawn breaking into day around "Milagre". Begin (or Skip) fades it
 * out over the onboarding steps; `onBegin` runs at once so the steps can come in under it, `onDone` once it is gone.
 * It waits for the startup splash to leave before it plays. Reduced motion lands on the last frame.
 */
export function OnboardingIntro({ onBegin, onDone }: { onBegin: () => void; onDone: () => void }) {
  const { phase } = useSplash();
  const [leaving, setLeaving] = useState(false);
  const [angle, setAngle] = useState(tailAngle);
  useEffect(() => {
    const resize = () => setAngle(tailAngle());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const begin = () => {
    if (leaving) return;
    setLeaving(true);
    onBegin();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === "Escape") begin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <section
      data-onboarding-intro
      data-playing={phase === "gone" || undefined}
      data-leaving={leaving || undefined}
      aria-labelledby="onboarding-intro-title"
      className="onboarding-intro"
      style={{ "--intro-tail-angle": `${angle}deg` } as CSSProperties}
      onAnimationEnd={(event) => {
        if (event.animationName === "onboarding-intro-leave") onDone();
      }}
    >
      <CloudFilters />
      <div className="onboarding-layer onboarding-intro-night" />
      <div className="onboarding-layer onboarding-intro-dawn" />
      <div className="onboarding-layer onboarding-intro-day" />
      <Stars />
      <div className="onboarding-intro-rays" aria-hidden />
      <CloudBank
        className="onboarding-intro-clouds"
        seed={4}
        count={9}
        top={SKY_H * 0.74}
        bottom={SKY_H * 0.9}
        shade="#e3d9ee"
        filter="onboarding-cloudy-soft"
      />
      <CloudBank className="onboarding-intro-clouds" seed={9} count={10} top={SKY_H * 0.84} bottom={SKY_H * 0.97} shade="#efe2dc" filter="onboarding-cloudy" />
      <div className="onboarding-intro-halo" aria-hidden />
      <svg className="onboarding-intro-mark" viewBox="-4 -4 154 154" aria-hidden>
        <path className="onboarding-intro-leg" d={MARK_LEFT} />
        <path className="onboarding-intro-leg onboarding-intro-leg-right" d={MARK_RIGHT} />
      </svg>
      <div className="onboarding-intro-comet" aria-hidden>
        <div className="onboarding-intro-tail" />
        <svg viewBox="26 -1 94 94">
          <path d={MARK_STAR} />
        </svg>
      </div>
      <div className="onboarding-intro-words">
        <h1 id="onboarding-intro-title">Milagre</h1>
        <p>
          Portuguese for <em>miracle</em>. Let’s make one.
        </p>
      </div>
      <button type="button" data-intro-begin className="onboarding-intro-begin" onClick={begin}>
        Begin
      </button>
      <div className="onboarding-intro-drag" />
      <button type="button" data-intro-skip className="onboarding-intro-skip" onClick={begin}>
        Skip
      </button>
    </section>
  );
}
