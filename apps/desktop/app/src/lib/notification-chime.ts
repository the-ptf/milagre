import type { NotificationChime } from "@milagre/shared/notification-chimes";
import miracle from "../assets/chimes/chime_miracle.mp3";
import faaah from "../assets/chimes/chime_faaah.mp3";
import bombasticSideEye from "../assets/chimes/chime_bombastic_side_eye.mp3";
import vineBoom from "../assets/chimes/chime_vine_boom.mp3";
import metalPipe from "../assets/chimes/chime_metal_pipe.mp3";
import bruh from "../assets/chimes/chime_bruh.mp3";
import emotionalDamage from "../assets/chimes/chime_emotional_damage.mp3";

const SOURCES: Record<Exclude<NotificationChime, "system">, string> = {
  miracle,
  faaah,
  "bombastic-side-eye": bombasticSideEye,
  "vine-boom": vineBoom,
  "metal-pipe": metalPipe,
  bruh,
  "emotional-damage": emotionalDamage,
};

let playing: HTMLAudioElement | null = null;

/** Plays a chime, cutting off the one still playing. "system" has no clip: the system notification plays its own sound. */
export function playNotificationChime(chime: string) {
  const source = SOURCES[chime as keyof typeof SOURCES];
  if (!source) return;
  playing?.pause();
  const audio = new Audio(source);
  audio.volume = 0.8;
  playing = audio;
  audio.play().catch(() => {});
}
