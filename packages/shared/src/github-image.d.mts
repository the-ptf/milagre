export function githubImageSource(source: string): { kind: "attachment"; url: string } | { kind: "repository"; url: string; mime: string } | null;
