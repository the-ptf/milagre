import { Redirect } from "expo-router";
import { PrChecks } from "../../pr-lists";
import { useCloseSheet, usePrRoute } from "../../pr-nav";

export default function PullRequestChecks() {
  const { route, cwd, number, client, valid } = usePrRoute();
  const close = useCloseSheet();
  if (!valid || !client || !cwd) return <Redirect href="/" />;
  return <PrChecks client={client} cwd={cwd} number={number} chatKey={route.chat} onChat={close} />;
}
