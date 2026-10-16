/** The inline scripts the renderer's srcdoc iframes run, which its policy pins by hash. */
export const RENDERER_INLINE_SCRIPTS: string[];

/** The packaged renderer's Content-Security-Policy; `pageScripts` are inline scripts of the page itself. */
export function rendererCsp(pageScripts?: string[]): string;
