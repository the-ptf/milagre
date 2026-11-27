export const EMAIL_CONNECTOR_ID: "email";
export const EMAIL_DESCRIPTION: string;
export const EMAIL_APP_PASSWORD_HINT: string;
export function guessImapHost(address: unknown): string;
export function appPasswordLink(address: unknown): { name: string; url: string } | null;
export const EMAIL_CONFIGURE_LABEL: string;
export const EMAIL_CONFIGURE_HINT: string;
export function emailSetupPrompt(address?: string): string;
