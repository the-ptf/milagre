import { useEffect, useRef } from "react";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";

export function useUltracodeAudio() {
  const player = useAudioPlayer(require("../assets/ultracode.mp3"));
  const { isLoaded } = useAudioPlayerStatus(player);
  const started = useRef(false);
  useEffect(() => {
    if (!isLoaded || started.current) return;
    started.current = true;
    let active = true;
    void setAudioModeAsync({ playsInSilentMode: false, shouldPlayInBackground: false, interruptionMode: "mixWithOthers" })
      .then(() => {
        if (active) {
          player.volume = 0.8;
          player.play();
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      try {
        player.pause();
      } catch {}
    };
  }, [player, isLoaded]);
}
