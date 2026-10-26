import { Redirect } from "expo-router";
import { PrThreads } from "../../pr-lists";
import { openPrPage, useCloseSheet, usePrRoute } from "../../pr-nav";

export default function PullRequestThreads() {
  const { route, cwd, number, client, valid } = usePrRoute();
  const close = useCloseSheet();
  if (!valid || !client || !cwd) return <Redirect href="/" />;
  return <PrThreads client={client} cwd={cwd} number={number} chatKey={route.chat} onChat={close} onOpenFile={(path) => openPrPage("diff", route, { path })} />;
}
