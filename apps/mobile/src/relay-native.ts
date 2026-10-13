import { beforeAiCall } from "./ai-consent";
import { AppState } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { createRelayTransport, type RelayTransport } from "./relay-transport";
import { phoneIdentity, phoneRandom } from "./phone-identity";
import { phoneName } from "./phone-name-native";
import type { RelayRuntime } from "./client";
import { lanRoutes } from "./routes-native";

/** One transport per Mac, shared by every client; a new pairing code for the same Mac replaces it. */
const open = new Map<string, { pairing: string; transport: RelayTransport }>();

// iOS suspends a backgrounded app and its sockets with it. Close them on the way out; the next request reopens.
AppState.addEventListener("change", (state) => {
  if (state === "background") for (const { transport } of open.values()) transport.close();
});

const folder = () => new Directory(Paths.cache, "relay-media");

/** The phone's side of the relay: its Keychain key, native randomness and the image cache folder. */
export const relayRuntime: RelayRuntime & { forget(hostId: string): void } = {
  beforeCall: beforeAiCall,
  async transport({ relay, token }) {
    let identity;
    try {
      identity = await phoneIdentity();
    } catch {
      throw new Error("Could not read this phone's pairing key. Unlock your phone and try again.");
    }
    const pairing = `${relay.url} ${relay.key} ${token}`;
    const current = open.get(relay.hostId);
    if (current?.pairing === pairing) return current.transport;
    current?.transport.close();
    const transport = createRelayTransport({ relay: relay.url, hostId: relay.hostId, key: relay.key, token, identity, random: phoneRandom, name: phoneName });
    open.set(relay.hostId, { pairing, transport });
    return transport;
  },
  /** A forgotten Mac's socket closes now, not when the app next goes to the background. */
  forget(hostId) {
    open.get(hostId)?.transport.close();
    open.delete(hostId);
  },
  lan: (host) => lanRoutes.view(host),
  files: {
    async find(name) {
      const file = new File(folder(), name);
      return file.exists ? file.uri : null;
    },
    async write(name, bytes) {
      const dir = folder();
      dir.create({ idempotent: true, intermediates: true });
      const file = new File(dir, name);
      file.write(bytes);
      return file.uri;
    },
  },
};
