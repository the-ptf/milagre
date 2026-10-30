import { PRIVACY_URL, SUPPORT_URL } from "@milagre/shared/site-links";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft01Icon, Cancel01Icon, ClipboardPasteIcon, KeyboardIcon, QrCodeIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { parsePairing, type Pairing } from "../pairing";
import { privatePairingLink } from "@milagre/shared/pairing-link";
import { useSession } from "../session";
import { Icon } from "../icons";
import { CircleButton, ErrorNotice, Field, Group, ListRow, PageScroll, PillButton, SheetHeader, useStyles } from "../ui";
import { lineHeight, radius, type } from "../design-tokens";
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
  const [privateOnly, setPrivateOnly] = useState(false);
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
      void pair(parsePairing(privateOnly ? privatePairingLink(text) : text));
    } catch (e) {
      setError((e as Error).message);
      setScanned(false);
    }
  }
  const header = (
    <SheetHeader
      title={manual ? "Enter manually" : "Add computer"}
      leading={
        manual ? (
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
        )
      }
      trailing={
        manual ? (
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
        ) : null
      }
    />
  );
  // A form sheet sizes its first scroll view to the sheet, so the header scrolls with the content.
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ padding: 0, gap: 0 }} automaticallyAdjustKeyboardInsets>
      <Stack.Screen options={{ headerShown: false }} />
      {header}
      <View style={{ padding: 16, paddingTop: 8, gap: 16 }}>
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
                borderRadius: radius.sheet,
                borderCurve: "continuous",
                overflow: "hidden",
                backgroundColor: colors.media,
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
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
                style={{
                  width: 200,
                  height: 200,
                  borderRadius: radius.sheet,
                  borderCurve: "continuous",
                  borderWidth: 3,
                  borderColor: colors.onMedia2,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {!permission?.granted && <Icon icon={QrCodeIcon} tone="onMedia2" size={64} />}
              </View>
              {permission?.granted ? (
                <Text style={{ color: colors.onMedia2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>Point at the QR code on your Mac</Text>
              ) : (
                <PillButton
                  secondary
                  title={permission?.canAskAgain === false ? "Allow camera access in Settings" : "Allow camera to scan"}
                  onPress={() => void (permission?.canAskAgain === false ? Linking.openSettings() : requestPermission())}
                />
              )}
            </View>
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>On your Mac</Text>
              <Text style={styles.text}>Open Milagre, go to Settings → Devices, turn on Allow devices to connect and scan the QR code it shows.</Text>
            </View>
            <Group
              inset={0}
              footer="Automatic tries LAN and Tailscale before the remote connection. Private pairing needs both devices on the same network or tailnet."
            >
              <ListRow title="LAN or Tailscale only" disabled={busy} toggle={{ value: privateOnly, onChange: () => setPrivateOnly(!privateOnly) }} />
            </Group>
            <Group>
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
                    if (privateOnly) {
                      setError("For private pairing, scan or paste the Mac's LAN or Tailscale pairing link.");
                      return;
                    }
                    setManual(true);
                    setError("");
                  },
                },
              ].map((row) => (
                <ListRow key={row.title} title={row.title} icon={row.icon} disabled={busy} onPress={row.onPress} />
              ))}
            </Group>
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
