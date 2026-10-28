import { PrThreads } from "../../pr-lists";
import { openPrPage, usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";

export default function PullRequestThreads() {
  const { route, cwd, number, client, valid, waiting } = usePrRoute();
  if (!valid || !client || !cwd) return <PrPending number={number} waiting={waiting} />;
  return <PrThreads client={client} cwd={cwd} number={number} onOpenFile={(path) => openPrPage("diff", route, { path })} />;
}
