import { useState, type ReactNode } from "react";

function ImageIcon({ src, fallback }: { src: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    fallback
  ) : (
    <img src={src} alt="" className="size-full rounded-inline object-contain" onError={() => setFailed(true)} referrerPolicy="no-referrer" />
  );
}

export function WorkspaceIcon({ src, fallback }: { src?: string | null; fallback: ReactNode }) {
  return src ? <ImageIcon key={src} src={src} fallback={fallback} /> : fallback;
}
