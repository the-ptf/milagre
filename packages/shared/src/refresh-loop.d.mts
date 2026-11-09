export function startRefreshLoop(options: {
  refresh: () => unknown | Promise<unknown>;
  isActive?: () => boolean;
  onActive?: (listener: () => void) => () => void;
  intervalMs?: number;
  repeat?: boolean;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}): () => void;
