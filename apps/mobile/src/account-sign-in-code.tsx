import { useState } from "react";
import { Linking, View } from "react-native";
import type { AccountsSnapshot, ModelProvider } from "@milagre/shared/model";
import { useSession } from "./session";
import type { Client } from "./client";
import { Field, InlineError, PillButton } from "./ui";

export function AccountSignInCode({
  client: chosen,
  provider,
  accountId,
  url,
  onDone,
}: {
  client?: Client | null;
  provider: ModelProvider;
  accountId: string;
  url: string;
  onDone: (next: AccountsSnapshot) => void;
}) {
  const sessionClient = useSession().client;
  const client = chosen ?? sessionClient;
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const submit = () => {
    if (!client || !code.trim()) return;
    setSending(true);
    setError("");
    client
      .call<AccountsSnapshot>("accounts:code", [provider, accountId, code])
      .then(onDone)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not send the code. Try again."))
      .finally(() => setSending(false));
  };
  return (
    <View style={{ gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
      <PillButton
        title="Open the sign-in link"
        size="small"
        variant="secondary"
        style={{ alignSelf: "flex-start" }}
        onPress={() => void Linking.openURL(url).catch(() => setError("Could not open the sign-in link."))}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Field
          label="Sign-in code"
          hideLabel
          placeholder="Paste the code"
          value={code}
          onChangeText={setCode}
          onSubmitEditing={submit}
          returnKeyType="done"
          textContentType="oneTimeCode"
          containerStyle={{ flex: 1 }}
        />
        <PillButton title="Sign in" size="small" loading={sending} disabled={sending || !code.trim()} onPress={submit} />
      </View>
      <InlineError message={error} />
    </View>
  );
}
