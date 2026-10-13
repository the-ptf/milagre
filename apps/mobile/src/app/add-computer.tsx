import { PRIVACY_URL, SUPPORT_URL } from "@milagre/shared/ai-consent";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon, ClipboardPasteIcon, KeyboardIcon, QrCodeIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { parsePairing, type Pairing } from "../pairing";
import { useSession } from "../session";
import { Icon } from "../icons";
import { CircleButton, ErrorNotice, Field, PageScroll, PillButton, useStyles } from "../ui";
import { useTheme } from "../theme";

/** One sheet, two steps: scan (with paste as a shortcut), or type the address and token. */
export default function AddComputer() {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("https://");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  async function pair(pairing: Pairing) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (await session.connect(pairing)) {
        router.dismissAll();
        router.replace("/projects");
      }
    } catch (e) {
      setError((e as Error).message);
      setScanned(false);
    } finally {
      setBusy(false);
    }
  }
  function fromLink(text: string) {
    try {
      void pair(parsePairing(text));
    } catch (e) {
      setError((e as Error).message);
      setScanned(false);
    }
  }
  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>
      {manual ? (
        <CircleButton
          label="Back"
          icon={ArrowLeft01Icon}
          onPress={() => {
            setManual(false);
            setError("");
          }}
        />
      ) : (
        <CircleButton label="Close" icon={Cancel01Icon} onPress={() => router.back()} />
      )}
      <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>
        {manual ? "Enter manually" : "Add computer"}
      </Text>
      {manual ? (
        <CircleButton
          label="Connect"
          icon={Tick02Icon}
          filled
          onPress={() => {
            try {
              void pair({ address: address.trim(), token: token.trim(), name: "" });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      ) : (
        <View style={{ width: 40 }} />
      )}
    </View>
  );
  // A form sheet sizes its first scroll view to the sheet, so the header scrolls with the content.
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0 }} automaticallyAdjustKeyboardInsets>
      <Stack.Screen options={{ headerShown: false }} />
      {header}
      <View style={{ padding: 20, paddingTop: 8, gap: 18 }}>
        {manual ? (
          <>
            <Field label="Computer address" value={address} onChangeText={setAddress} keyboardType="url" autoFocus />
            <Field
              label="Connection token"
              value={token}
              onChangeText={setToken}
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              secureTextEntry
            />
            <Text style={styles.caption}>Both are in the connection file the host prints. Remote computers need an HTTPS address.</Text>
          </>
        ) : (
          <>
            <View
              style={{
                height: 320,
                borderRadius: 24,
                borderCurve: "continuous",
                overflow: "hidden",
                backgroundColor: "#15171a",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
              }}
            >
              {permission?.granted ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={
                    scanned
                      ? undefined
                      : ({ data }) => {
                          setScanned(true);
                          fromLink(data);
                        }
                  }
                />
              ) : null}
              <View
                pointerEvents="none"
                style={{ width: 200, height: 200, borderRadius: 28, borderWidth: 3, borderColor: "#ffffffcc", alignItems: "center", justifyContent: "center" }}
              >
                {!permission?.granted && <Icon icon={QrCodeIcon} color="#ffffff55" size={64} />}
              </View>
              {permission?.granted ? (
                <Text style={{ color: "#ffffffcc", fontSize: 14 }}>Point at the QR code on your Mac</Text>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void (permission?.canAskAgain === false ? Linking.openSettings() : requestPermission())}
                  style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, backgroundColor: "#ffffff26" }}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
                    {permission?.canAskAgain === false ? "Allow camera access in Settings" : "Allow camera to scan"}
                  </Text>
                </Pressable>
              )}
            </View>
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>On your Mac</Text>
              <Text style={styles.text}>Open Milagre, go to Settings → Devices, turn on Allow devices to connect and scan the QR code it shows.</Text>
            </View>
            <View style={[styles.card, { paddingVertical: 0, gap: 0 }]}>
              {[
                {
                  icon: ClipboardPasteIcon,
                  title: "Paste pairing link",
                  onPress: () =>
                    void Clipboard.getStringAsync()
                      .then(fromLink)
                      .catch(() => setError("Could not read the clipboard. Copy the pairing link again.")),
                },
                {
                  icon: KeyboardIcon,
                  title: "Enter address and token",
                  onPress: () => {
                    setManual(true);
                    setError("");
                  },
                },
              ].map((row, index) => (
                <View key={row.title}>
                  {index > 0 && <View style={styles.separator} />}
                  <Pressable
                    accessibilityRole="button"
                    onPress={row.onPress}
                    disabled={busy}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, opacity: pressed ? 0.5 : 1 })}
                  >
                    <Icon icon={row.icon} tone="accent" size={20} />
                    <Text style={[styles.text, { flex: 1 }]}>{row.title}</Text>
                    <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
                  </Pressable>
                </View>
              ))}
            </View>
          </>
        )}
        <Text style={styles.caption}>Pairing gives this device access to your computer&apos;s Projects and Chats. Keep pairing links private.</Text>
        <View style={{ flexDirection: "row", gap: 24 }}>
          {[
            { title: "Privacy policy", url: PRIVACY_URL },
            { title: "Support", url: SUPPORT_URL },
          ].map(({ title, url }) => (
            <Pressable
              key={url}
              accessibilityRole="link"
              onPress={() => void Linking.openURL(url).catch(() => setError(`Could not open this page. Visit ${url} in your browser.`))}
              style={{ paddingVertical: 12 }}
            >
              <Text style={[styles.text, { textDecorationLine: "underline" }]}>{title}</Text>
            </Pressable>
          ))}
        </View>
        {busy && <PillButton title="Connecting…" loading onPress={() => {}} secondary />}
        {error ? <ErrorNotice message={error} /> : null}
      </View>
    </PageScroll>
  );
}
