export function Skeleton({ secondary = false, className = "" }: { secondary?: boolean; className?: string }) {
  return <span aria-hidden className={`block rounded-inline motion-safe:animate-pulse ${secondary ? "bg-hover" : "bg-hover-2"} ${className}`} />;
}
