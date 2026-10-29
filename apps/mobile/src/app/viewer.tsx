import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
  type ScrollViewInstance,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icons";
import { useMedia } from "../chat-reply";
import { viewerImages, type MediaValue, type ThumbRect } from "../viewer-store";

// Desktop's SPRING_LAYOUT (lib/ease.ts), the spring its lightbox morphs with.
const SPRING = { stiffness: 360, damping: 32, mass: 0.6, useNativeDriver: true } as const;
const FILL = 0.78;

/** The image's natural size, so the morph lines the fitted image up with its thumbnail. */
async function naturalSize(value: MediaValue | undefined): Promise<{ width: number; height: number } | null> {
  let source: ImageSourcePropType | undefined;
  // A relay image still loading does not hold up the opening morph; it fades in instead.
  try {
    source = await Promise.race([value, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000))]);
  } catch {
    return null;
  }
  const remote = source as { uri?: string; headers?: Record<string, string> };
  if (!remote?.uri) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (width: number, height: number) => resolve(width && height ? { width, height } : null);
    if (remote.headers) Image.getSizeWithHeaders(remote.uri!, remote.headers, done, () => resolve(null));
    else Image.getSize(remote.uri!, done, () => resolve(null));
  });
}

/** How far a double tap zooms in, and the most a pinch can. */
const DOUBLE_TAP_ZOOM = 2.5;
const MAX_ZOOM = 4;

/**
 * One full-screen image, like Photos: pinch or double-tap to zoom (iOS), pan around it zoomed, double-tap again to fit.
 * A relay image that is still loading leaves the space empty.
 */
function Figure({
  name,
  source,
  width,
  height,
  scrollRef,
  onZoom,
}: {
  name: string;
  source: MediaValue;
  width: number;
  height: number;
  scrollRef: (view: ScrollViewInstance | null) => void;
  onZoom: (zoomed: boolean) => void;
}) {
  const ready = useMedia(source);
  const [ratio, setRatio] = useState<number | null>(null);
  const view = useRef<ScrollViewInstance | null>(null);
  const scale = useRef(1);
  const tap = useRef({ x: 0, y: 0, t: 0, last: 0 });
  // The image fitted inside the page's image area, so a zoomed image pans to its own edges, not into letterbox bars.
  const box = height * FILL;
  const fitted = !ratio ? { width, height: box } : ratio > width / box ? { width, height: width / ratio } : { width: box * ratio, height: box };
  const doubleTap = (x: number, y: number) => {
    // Android's ScrollView does not zoom.
    if (Platform.OS !== "ios") return;
    if (scale.current > 1.01) return view.current?.scrollResponderZoomTo({ x: 0, y: 0, width: fitted.width, height: fitted.height });
    // At fit the content sits centred on the page: move the tap into the image's own coordinates and zoom around it.
    const cx = Math.min(fitted.width, Math.max(0, x - (width - fitted.width) / 2)),
      cy = Math.min(fitted.height, Math.max(0, y - (height - fitted.height) / 2));
    const w = width / DOUBLE_TAP_ZOOM,
      h = height / DOUBLE_TAP_ZOOM;
    view.current?.scrollResponderZoomTo({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
  };
  return (
    <ScrollView
      ref={(node) => {
        view.current = node;
        scrollRef(node);
      }}
      style={{ width, height }}
      maximumZoomScale={MAX_ZOOM}
      minimumZoomScale={1}
      bouncesZoom
      centerContent
      // At fit nothing scrolls, so a downward drag stays free to pull the viewer closed.
      alwaysBounceHorizontal={false}
      alwaysBounceVertical={false}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={32}
      onScroll={({ nativeEvent }) => {
        const zoom = nativeEvent.zoomScale ?? 1;
        if (zoom > 1.01 !== scale.current > 1.01) onZoom(zoom > 1.01);
        scale.current = zoom;
      }}
      onTouchStart={({ nativeEvent: e }) => {
        tap.current.x = e.pageX;
        tap.current.y = e.pageY;
        tap.current.t = e.timestamp;
      }}
      onTouchEnd={({ nativeEvent: e }) => {
        // A tap is a short touch that barely moved; two of them close together in time and place are a double tap.
        const still = Math.abs(e.pageX - tap.current.x) < 10 && Math.abs(e.pageY - tap.current.y) < 10 && e.timestamp - tap.current.t < 250;
        if (!still || e.touches.length > 0) return void (tap.current.last = 0);
        if (e.timestamp - tap.current.last < 300) {
          tap.current.last = 0;
          doubleTap(e.pageX, e.pageY);
        } else tap.current.last = e.timestamp;
      }}
    >
      {ready ? (
        <Image
          accessibilityLabel={name}
          source={ready}
          resizeMode="contain"
          onLoad={({ nativeEvent }) => {
            const { width: w, height: h } = nativeEvent.source;
            if (w > 0 && h > 0) setRatio(w / h);
          }}
          style={fitted}
        />
      ) : (
        <View accessibilityLabel={name} style={fitted} />
      )}
    </ScrollView>
  );
}

/**
 * Full-screen images, like desktop's lightbox: the image grows out of the thumbnail you tapped and shrinks back into
 * it on close. ✕ trailing; swipe sideways between a message's images, swipe down to close.
 */
export default function Viewer() {
  const { images, index } = viewerImages();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState(index);
  const current = images[page];
  const [progress] = useState(() => new Animated.Value(0));
  const [drag] = useState(() => new Animated.Value(0));
  // The thumbnail pose (offset, scale) and whether to fade instead. They are animated values set before each spring, so
  // the animated style keeps one shape: swapping native-driven props between renders left the image invisible.
  const [pose] = useState(() => ({ dx: new Animated.Value(0), dy: new Animated.Value(0), scale: new Animated.Value(0.96), fade: new Animated.Value(1) }));
  const setPose = (to: { dx: number; dy: number; scale: number } | null) => {
    pose.dx.setValue(to?.dx ?? 0);
    pose.dy.setValue(to?.dy ?? 0);
    pose.scale.setValue(to?.scale ?? 0.96);
    pose.fade.setValue(to ? 0 : 1);
  };
  const closingRef = useRef(false);
  // Each page's zoom view, and whether the page on screen is zoomed in: zoomed, a drag pans the image instead of closing.
  const pages = useRef(new Map<number, ScrollViewInstance>());
  const zoomed = useRef(false);
  // The list renders its pages once, so their callbacks read the page on screen from here.
  const pageRef = useRef(index);
  const fit = (i: number) => {
    if (Platform.OS === "ios") pages.current.get(i)?.scrollResponderZoomTo({ x: 0, y: 0, width, height });
  };
  // Where a touch started, to tell a downward pull from a sideways swipe between images.
  const touch = useRef({ x: 0, y: 0, t: 0 });

  // Where the fitted image sits, scaled and moved onto a thumbnail: scale matches widths, the centers meet.
  const toThumb = async (from: ThumbRect | undefined, source: MediaValue | undefined) => {
    if (!from) return null;
    const size = await naturalSize(source);
    const ratio = size ? size.width / size.height : from.width / from.height;
    const fitted = ratio > width / (height * FILL) ? width : height * FILL * ratio;
    return { dx: from.x + from.width / 2 - width / 2, dy: from.y + from.height / 2 - height / 2, scale: from.width / fitted };
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([AccessibilityInfo.isReduceMotionEnabled(), toThumb(images[index]?.from, images[index]?.source)]).then(([reduced, start]) => {
      if (cancelled) return;
      setPose(reduced ? null : start);
      Animated.spring(progress, { toValue: 1, ...SPRING }).start();
    });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- opens once

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (zoomed.current) fit(page);
    void Promise.all([AccessibilityInfo.isReduceMotionEnabled(), toThumb(current?.from, current?.source)]).then(([reduced, end]) => {
      setPose(reduced ? null : end);
      Animated.parallel([Animated.spring(progress, { toValue: 0, ...SPRING }), Animated.spring(drag, { toValue: 0, ...SPRING })]).start(() => router.back());
    });
  };

  // A vertical drag pulls the image down; far or fast enough closes, like Photos.
  const pull = {
    onTouchStart: ({ nativeEvent: e }: { nativeEvent: { pageX: number; pageY: number; timestamp: number } }) => {
      touch.current = { x: e.pageX, y: e.pageY, t: e.timestamp };
    },
    onMoveShouldSetResponder: ({ nativeEvent: e }: { nativeEvent: { pageX: number; pageY: number; touches: readonly unknown[] } }) => {
      if (zoomed.current || e.touches.length > 1) return false;
      const dy = e.pageY - touch.current.y,
        dx = e.pageX - touch.current.x;
      return dy > 12 && Math.abs(dy) > Math.abs(dx) * 1.5;
    },
    onResponderMove: ({ nativeEvent: e }: { nativeEvent: { pageY: number } }) => drag.setValue(Math.max(0, e.pageY - touch.current.y)),
    onResponderRelease: ({ nativeEvent: e }: { nativeEvent: { pageY: number; timestamp: number } }) => {
      const dy = e.pageY - touch.current.y,
        speed = dy / Math.max(1, e.timestamp - touch.current.t);
      if (dy > 140 || speed > 1.2) close();
      else Animated.spring(drag, { toValue: 0, ...SPRING }).start();
    },
  };
  // At progress 0 the image sits on its thumbnail (or is faded and slightly small); at 1 it fills the screen.
  const rest = Animated.subtract(1, progress);
  const figure = {
    opacity: Animated.add(Animated.subtract(1, pose.fade), Animated.multiply(pose.fade, progress)),
    transform: [
      { translateX: Animated.multiply(pose.dx, rest) },
      { translateY: Animated.add(Animated.multiply(pose.dy, rest), drag) },
      { scale: Animated.add(1, Animated.multiply(Animated.subtract(pose.scale, 1), rest)) },
    ],
  };
  const chrome = { opacity: Animated.multiply(progress, drag.interpolate({ inputRange: [0, 200], outputRange: [1, 0], extrapolate: "clamp" })) };
  return (
    <View {...pull} style={{ flex: 1 }}>
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "#000",
          opacity: Animated.multiply(progress, drag.interpolate({ inputRange: [0, 300], outputRange: [1, 0.4], extrapolate: "clamp" })),
        }}
      />
      <Animated.View style={[{ flex: 1 }, figure]}>
        <FlatList
          data={images}
          horizontal
          pagingEnabled
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={(_, i) => String(i)}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={({ nativeEvent }) => {
            const next = Math.round(nativeEvent.contentOffset.x / width);
            if (next === page) return;
            // Like Photos, the image you swiped away from is back at fit when you return to it.
            fit(page);
            zoomed.current = false;
            pageRef.current = next;
            setPage(next);
          }}
          renderItem={({ item, index: i }) => (
            <Figure
              name={item.name}
              source={item.source}
              width={width}
              height={height}
              scrollRef={(view) => (view ? pages.current.set(i, view) : pages.current.delete(i))}
              onZoom={(on) => {
                if (i === pageRef.current) zoomed.current = on;
              }}
            />
          )}
        />
      </Animated.View>
      <Animated.View
        style={[
          { position: "absolute", top: insets.top + 6, left: 16, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
          chrome,
        ]}
      >
        <View style={{ width: 44 }} />
        <View style={{ alignItems: "center", flex: 1 }}>
          <Text numberOfLines={1} style={{ color: "#fff", fontSize: 15, fontWeight: "600" }}>
            {images.length > 1 ? `${page + 1} of ${images.length}` : current?.name}
          </Text>
          {images.length > 1 && (
            <Text numberOfLines={1} style={{ color: "#ffffff99", fontSize: 12 }}>
              {current?.name}
            </Text>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={6}
          onPress={close}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: "#ffffff26",
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon icon={Cancel01Icon} color="#ffffff" size={20} />
        </Pressable>
      </Animated.View>
      {images.length > 1 && (
        <Animated.View
          style={[{ position: "absolute", bottom: insets.bottom + 18, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 6 }, chrome]}
        >
          {images.map((_, i) => (
            <View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: i === page ? "#fff" : "#ffffff59" }} />
          ))}
        </Animated.View>
      )}
    </View>
  );
}
