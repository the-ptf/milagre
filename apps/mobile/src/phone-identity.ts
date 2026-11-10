import * as SecureStore from "expo-secure-store";
import { getRandomBytes } from "expo-crypto";
import { b64url, boxKeyPair, fromB64url, type KeyPair } from "@milagre/shared/relay-crypto";

const KEY = "milagre.phone-key.v1";
/** Randomness for the relay handshake: the app's native source, not Math.random. */
export const phoneRandom = (n: number) => getRandomBytes(n);

function parse(value: string | null): KeyPair | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as { publicKey?: unknown; secretKey?: unknown };
    if (typeof stored.publicKey !== "string" || typeof stored.secretKey !== "string") return null;
    const publicKey = fromB64url(stored.publicKey);
    const secretKey = fromB64url(stored.secretKey);
    return publicKey.length === 32 && secretKey.length === 32 ? { publicKey, secretKey } : null;
  } catch {
    return null;
  }
}

/** Whether this phone has a pairing key, which it makes the first time it pairs; reading it never makes one. */
export async function hasPhoneKey() {
  return parse(await SecureStore.getItemAsync(KEY)) !== null;
}

let cached: Promise<KeyPair> | null = null;

async function load(): Promise<KeyPair> {
  // A failed read is thrown, not replaced: a new key would silently unpair this phone from every Mac.
  const existing = parse(await SecureStore.getItemAsync(KEY));
  if (existing) return existing;
  const created = boxKeyPair(phoneRandom);
  await SecureStore.setItemAsync(KEY, JSON.stringify({ publicKey: b64url(created.publicKey), secretKey: b64url(created.secretKey) }), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return created;
}

/** This phone's key pair for the relay. It is made on first use and stays in the Keychain on this device. */
export function phoneIdentity(): Promise<KeyPair> {
  cached ??= load().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}
