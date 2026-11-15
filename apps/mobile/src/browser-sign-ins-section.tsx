import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { SIGN_INS_FOOTER, SIGN_INS_TITLE, SIGN_OUT, SIGNED_OUT, SIGNING_OUT, type BrowserSignIns } from "@milagre/shared/browser-sign-ins";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { ErrorNotice, pressStyle, useStyles } from "./ui";
import { hitSlopFor, lineHeight, space, type } from "./design-tokens";

/**
 * Settings › Browser: the connected computer's Browser panel sign-ins, its own Chats' and each paired computer's, each
 * signed out on its own (desktop Settings › Browser). Hidden on a computer too old to list them.
 */
export function BrowserSignInsSection() {
  const styles = useStyles();
  const session = useSession();
  const host = session.client ? session.hosts.find((saved) => saved.id === session.client?.url) : undefined;
  const macName = host?.name || session.hostName || "your computer";
  const [list, setList] = useState<BrowserSignIns["sessions"] | null>(null);
  const [error, setError] = useState("");
  useFocusEffect(
    useCallback(() => {
      const client = session.client;
      if (!client) return;
      let live = true;
      client.call<BrowserSignIns>("browser:sign-ins", []).then(
        (value) => live && setList(value.sessions),
        () => live && setList(null),
      );
      return () => {
        live = false;
      };
    }, [session.client]),
  );
  if (!list) return null;
  return (
    <>
      <Text style={[styles.section, { marginTop: 24 }]}>{`${SIGN_INS_TITLE} on ${macName}`}</Text>
      <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
        {list.map((item, index) => (
          <View key={item.id}>
            {index > 0 && <View style={styles.separator} />}
            <SignOutRow computerId={item.id} name={item.name ?? macName} onError={setError} />
          </View>
        ))}
      </View>
      <Text style={[styles.caption, { marginTop: 8, paddingHorizontal: 4 }]}>{SIGN_INS_FOOTER}</Text>
      {error ? <ErrorNotice message={error} /> : null}
    </>
  );
}

function SignOutRow({ computerId, name, onError }: { computerId: string; name: string; onError: (message: string) => void }) {
  const session = useSession();
  const { colors } = useTheme();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  useEffect(() => {
    if (state !== "done") return;
    const timer = setTimeout(() => setState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  async function signOut() {
    const client = session.client;
    if (!client) return;
    setState("busy");
    onError("");
    try {
      await client.call("browser:sign-ins:clear", [computerId]);
      setState("done");
    } catch (failure) {
      setState("idle");
      onError(failure instanceof Error ? failure.message : `Could not sign ${name} out.`);
    }
  }
  const label = state === "busy" ? SIGNING_OUT : state === "done" ? SIGNED_OUT : SIGN_OUT;
  // A plain row, not settings-list's Row: that one is a Pressable, which VoiceOver reads as one element, hiding Sign out.
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: 52 }}>
      <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body }}>
        {name}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${SIGN_OUT}: ${name}`}
        accessibilityState={{ disabled: state !== "idle", busy: state === "busy" }}
        disabled={state !== "idle"}
        hitSlop={hitSlopFor(lineHeight.body)}
        onPress={() => void signOut()}
        style={({ pressed }) => pressStyle({ pressed })}
      >
        <Text style={{ color: state === "idle" ? colors.redInk : colors.ink3, fontSize: type.body, lineHeight: lineHeight.body }}>{label}</Text>
      </Pressable>
    </View>
  );
}
