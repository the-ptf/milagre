/**
 * A loading placeholder bar: hover-2 for the main line, hover (`secondary`) for the one under it, 4px corners, a
 * pulse unless motion is reduced. Size it with `className` (h-3 w-32).
 */
export function Skeleton({ secondary = false, className = "" }: { secondary?: boolean; className?: string }) {
  return <span aria-hidden className={`block rounded-inline motion-safe:animate-pulse ${secondary ? "bg-hover" : "bg-hover-2"} ${className}`} />;
}
