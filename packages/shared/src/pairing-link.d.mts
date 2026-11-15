export type Access = { id: string; secret: string };
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
export type PairingOptions = { allowLocalRelay?: boolean };
export function validAccess(value: unknown): Access | undefined;
export function localEndpoint(input: string): string;
export function privateDeviceEndpoint(input: string, options?: PairingOptions): boolean;
export function validRelay(value: unknown, options?: PairingOptions): RelayLink;
export function relayAddress(hostId: string): string;
export function privatePairingLink(input: string): string;
export function parsePairing(input: string, options?: PairingOptions): Pairing;
