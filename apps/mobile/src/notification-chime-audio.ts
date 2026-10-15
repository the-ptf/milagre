import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import type { NotificationChime } from "@milagre/shared/notification-chimes";

// The same wavs app.json bundles for push sounds, loaded here to preview a chime in Settings > Experimental.
const SOURCES: Record<Exclude<NotificationChime, "system">, number> = {
  miracle: require("../assets/sounds/chime_miracle.wav"),
  faaah: require("../assets/sounds/chime_faaah.wav"),
  "bombastic-side-eye": require("../assets/sounds/chime_bombastic_side_eye.wav"),
  "vine-boom": require("../assets/sounds/chime_vine_boom.wav"),
  "metal-pipe": require("../assets/sounds/chime_metal_pipe.wav"),
  bruh: require("../assets/sounds/chime_bruh.wav"),
  "emotional-damage": require("../assets/sounds/chime_emotional_damage.wav"),
};

let playing: AudioPlayer | null = null;

/** Plays a chime, cutting off the one still playing. "system" has no clip of its own. Respects the silent switch, like a push. */
export function playNotificationChime(chime: NotificationChime) {
  const source = SOURCES[chime as keyof typeof SOURCES];
  if (!source) return;
  playing?.remove();
  playing = null;
  void setAudioModeAsync({ playsInSilentMode: false, shouldPlayInBackground: false, interruptionMode: "mixWithOthers" })
    .then(() => {
      const player = createAudioPlayer(source);
      playing = player;
      player.volume = 0.8;
      player.play();
    })
    .catch(() => {});
}
