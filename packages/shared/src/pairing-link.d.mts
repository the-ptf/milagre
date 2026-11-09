/** A Cloudflare Access service token: the edge drops any request to the host's tunnel without it. */
export type Access = { id: string; secret: string };
/** An encrypted device channel with a pinned identity, private routes and an optional public fallback. */
export type RelayLink = {
  url: string;
  hostId: string;
  key: string;
  direct?: string[];
};
export type Pairing = {
  address: string;
  token: string;
  name: string;
  access?: Access;
  relay?: RelayLink;
};
/** `allowLocalRelay`: also take a relay on this machine (ws://127.0.0.1); tests only. */
export type PairingOptions = { allowLocalRelay?: boolean };
export function validAccess(value: unknown): Access | undefined;
export function localEndpoint(input: string): string;
export function privateDeviceEndpoint(input: string, options?: PairingOptions): boolean;
export function validRelay(value: unknown, options?: PairingOptions): RelayLink;
export function relayAddress(hostId: string): string;
export function privatePairingLink(input: string): string;
export function parsePairing(input: string, options?: PairingOptions): Pairing;
