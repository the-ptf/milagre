import { PrThreads } from "../../pr-lists";
import { openPrPage, useCloseSheet, usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";

export default function PullRequestThreads() {
  const { route, cwd, number, client, valid, waiting } = usePrRoute();
  const close = useCloseSheet();
  if (!valid || !client || !cwd) return <PrPending number={number} waiting={waiting} />;
  return <PrThreads client={client} cwd={cwd} number={number} chatKey={route.chat} onChat={close} onOpenFile={(path) => openPrPage("diff", route, { path })} />;
}
