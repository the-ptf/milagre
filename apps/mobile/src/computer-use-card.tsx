import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View, type View as ViewInstance } from "react-native";
import { router } from "expo-router";
import { Cancel01Icon, CircleIcon, ComputerIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { desktopStepApps, desktopStepLabel, frameFitsSteps } from "@milagre/shared/desktop-steps";
import type { ComputerUseFrame } from "@milagre/shared/computer-use";
import type { ChatStep } from "@milagre/shared/model";
import { Icon } from "./icons";
import { useSession } from "./session";
import { radius, type } from "./design-tokens";
import { useTheme } from "./theme";
import { showImages } from "./viewer-store";

// The newest steps under the screen; earlier ones behind a button, as on desktop.
const VISIBLE_STEPS = 6;

/**
 * The Chat's live screen, as on desktop: long-polls the Mac for the next frame while its agent works, and keeps the
 * last one. Starts again when the reply gets a new desktop step.
 */
function useScreen(chatId: string | undefined, stepCount: number) {
  const { client } = useSession();
  const [frame, setFrame] = useState<ComputerUseFrame | null>(null);
  useEffect(() => {
    if (!client || !chatId) return;
    const state = { disposed: false };
    void (async () => {
      let after = 0;
      while (!state.disposed) {
        const next = await client.call<ComputerUseFrame>("computer-use:frame", [{ chatId, after }]).catch(() => null);
        if (state.disposed || !next) return;
        if (next.seq !== after || !next.live) setFrame(next);
        after = next.seq;
        if (!next.live) return;
      }
    })();
    return () => {
      state.disposed = true;
    };
  }, [client, chatId, stepCount]);
  return frame;
}

/**
 * A reply's computer use: the app's window on top (tap for full screen), its desktop steps numbered below, in one card
 * instead of tool rows. Desktop shows the same card with the steps beside the screen.
 */
export function ComputerUseCard({ steps, chatId }: { steps: ChatStep[]; chatId?: string }) {
  const { colors } = useTheme();
  const frame = useScreen(chatId, steps.length);
  const thumb = useRef<ViewInstance>(null);
  const [allSteps, setAllSteps] = useState(false);
  const shown = frame && frameFitsSteps(frame.at, steps) ? frame : null;
  // The host keeps capturing for a while after the last step, then says the feed is no longer live.
  const live = !!shown?.live;
  const uri = shown?.image ? `data:${shown.mime ?? "image/png"};base64,${shown.image}` : null;
  const apps = desktopStepApps(steps);
  const ratio = shown?.width && shown.height ? shown.width / shown.height : 16 / 10;
  const open = () => {
    if (!uri) return;
    const name = shown?.title ? `${shown.app} · ${shown.title}` : (shown?.app ?? "Screen");
    const finish = (from?: { x: number; y: number; width: number; height: number }) => {
      showImages([{ source: { uri }, name, ...(from ? { from } : {}) }], 0);
      router.push("/viewer");
    };
    if (thumb.current) thumb.current.measureInWindow((x, y, width, height) => finish(width && height ? { x, y, width, height } : undefined));
    else finish();
  };
  return (
    <View style={{ borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, height: 40 }}>
        {live ? (
          <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.green }} />
        ) : (
          <Icon icon={ComputerIcon} size={15} tone="ink2" />
        )}
        {live && <Text style={{ color: colors.greenInk, fontSize: 13, fontWeight: "600" }}>Live</Text>}
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontSize: 13 }}>
          {[apps.join(", "), `${steps.length} ${steps.length === 1 ? "step" : "steps"}`].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Pressable
        ref={thumb}
        accessibilityRole={uri ? "imagebutton" : undefined}
        accessibilityLabel={uri ? `${shown?.app ?? "The app"}'s window. Open full screen` : undefined}
        disabled={!uri}
        onPress={open}
        style={{ backgroundColor: colors.field, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line }}
      >
        {uri ? (
          <Image source={{ uri }} resizeMode="contain" style={{ width: "100%", aspectRatio: ratio, maxHeight: 320 }} />
        ) : (
          <Text style={{ color: colors.ink3, fontSize: 13, textAlign: "center", paddingVertical: 36, paddingHorizontal: 24 }}>
            {shown?.error === "screen-recording"
              ? "Turn on Screen Recording for Milagre on the Mac (Settings › Experimental › Computer use) to see the screen here."
              : "The screen shows here while the agent works in an app."}
          </Text>
        )}
      </Pressable>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
        {steps.length > VISIBLE_STEPS && !allSteps && (
          <Pressable accessibilityRole="button" onPress={() => setAllSteps(true)} hitSlop={8}>
            <Text style={{ color: colors.ink3, fontSize: type.footnote }}>
              {`${steps.length - VISIBLE_STEPS} earlier ${steps.length - VISIBLE_STEPS === 1 ? "step" : "steps"}`}
            </Text>
          </Pressable>
        )}
        {(allSteps ? steps : steps.slice(-VISIBLE_STEPS)).map((step) => (
          <Step key={step.id} step={step} />
        ))}
      </View>
    </View>
  );
}

function Step({ step }: { step: ChatStep }) {
  const { colors } = useTheme();
  const running = step.status === "running";
  const failed = step.status === "failed";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {running ? (
        <ActivityIndicator size="small" color={colors.ink} style={{ width: 15, height: 15, transform: [{ scale: 0.7 }] }} />
      ) : failed ? (
        <Icon icon={Cancel01Icon} size={15} tone="redInk" />
      ) : step.status === "done" ? (
        <Icon icon={Tick02Icon} size={15} tone="greenInk" />
      ) : (
        <Icon icon={CircleIcon} size={15} tone="ink3" />
      )}
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontSize: type.subheadline, color: running ? colors.ink : failed ? colors.redInk : colors.ink2, fontWeight: running ? "600" : "400" }}
      >
        {desktopStepLabel(step)}
      </Text>
    </View>
  );
}
