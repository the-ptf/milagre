export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
export type Channel = {
  seal(value: unknown): Uint8Array;
  /** Seals the UTF-8 bytes of a message already encoded as JSON; the other side opens it as it opens seal()'s. */
  sealEncoded(plain: Uint8Array): Uint8Array;
  open(frame: Uint8Array): unknown;
};
export type Random = (n: number) => Uint8Array;
export type RelayAuthCode = "unknown-phone" | "bad-token" | "bad-hello";

export class RelayAuthError extends Error {
  code: RelayAuthCode;
  constructor(code: RelayAuthCode, message: string);
}

export function b64url(bytes: Uint8Array): string;
export function fromB64url(text: string): Uint8Array;
export function boxKeyPair(random: Random): KeyPair;
export function signKeyPair(random: Random): KeyPair;
export function hostIdOf(signPublicKey: Uint8Array): string;
export type DeviceKind = "phone" | "desktop";
export function helloName(value: unknown): string | null;
export function phoneHello(args: {
  phone: KeyPair;
  host: Uint8Array;
  token: string;
  random: Random;
  name?: string | null;
  kind?: DeviceKind;
  caps?: string[];
}): {
  message: Uint8Array;
  ephemeral: KeyPair;
};
export function hostAccept(args: {
  host: KeyPair;
  hello: Uint8Array;
  isKnown: (phoneKey: string) => boolean;
  canPair?: boolean | ((phoneKey: string) => boolean);
  token: string;
  random: Random;
}): { reply: Uint8Array; channel: Channel; phoneKey: string; firstPairing: boolean; kind: DeviceKind; name: string | null; caps: string[] };
export function phoneFinish(args: { ephemeral: KeyPair; phone: KeyPair; host: Uint8Array; reply: Uint8Array }): Channel;
