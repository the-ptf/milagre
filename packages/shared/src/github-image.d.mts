export function githubImageSource(
  source: string,
):
  | { kind: "attachment"; url: string }
  | { kind: "repository"; url: string; mime: string; resolve?: { endpoint: string; namespace: string | null; parts: string[] } }
  | null;
