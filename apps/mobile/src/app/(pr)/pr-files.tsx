import { PrFiles } from "../../pr-lists";
import { openPrPage, usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";

export default function PullRequestFiles() {
  const { route, cwd, number, client, valid, waiting } = usePrRoute();
  if (!valid || !client || !cwd) return <PrPending number={number} waiting={waiting} />;
  return <PrFiles client={client} cwd={cwd} number={number} onOpenFile={(file) => openPrPage("diff", route, { path: file.path })} />;
}
