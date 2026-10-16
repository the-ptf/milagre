import type { BotRecord } from "@milagre/shared/bots";

// A bot's static mascot: its body in its color, white eyes with dark pupils and a smile. Drawn on a 44-unit grid.
const FACE = "#16181d";

function Body({ body, color }: { body: BotRecord["body"]; color: string }) {
  if (body === "squircle") return <rect x={3} y={3} width={38} height={38} rx={38 * 0.34} fill={color} />;
  if (body === "capsule") return <rect x={7} y={2} width={30} height={40} rx={15} fill={color} />;
  return <circle cx={22} cy={22} r={20} fill={color} />;
}

export function BotAvatar({ color, body, size = 28, className = "" }: { color: string; body: BotRecord["body"]; size?: number; className?: string }) {
  return (
    <svg aria-hidden data-bot-avatar width={size} height={size} viewBox="0 0 44 44" className={`shrink-0 ${className}`}>
      <Body body={body} color={color} />
      <circle cx={16} cy={19} r={5} fill="#fff" />
      <circle cx={28} cy={19} r={5} fill="#fff" />
      <circle cx={16.8} cy={19.8} r={2.4} fill={FACE} />
      <circle cx={28.8} cy={19.8} r={2.4} fill={FACE} />
      <path d="M17 28.5 Q22 32.5 27 28.5" fill="none" stroke={FACE} strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}
