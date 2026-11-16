import { lazyView } from "../../lib/lazy-view";

export const MediaLightbox = lazyView(() => import("./MediaLightbox").then((module) => module.MediaLightbox));
