/** Load the login-shell PATH before desktop tools inspect installed applications. */
export function loadLoginEnvironment(options?: {
  target?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  shell?: string;
  readShellEnv?: (options: { shell: string; env: NodeJS.ProcessEnv }) => Promise<NodeJS.ProcessEnv | null>;
  dirs?: (home: string) => string[];
  npmBin?: (options: { env: NodeJS.ProcessEnv; home: string }) => Promise<string | null>;
}): Promise<{ source: "none" | "shell" | "fallback" }>;
