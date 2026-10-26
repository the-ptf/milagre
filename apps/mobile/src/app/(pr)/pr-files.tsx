import { Redirect } from "expo-router";
import { PrFiles } from "../../pr-lists";
import { openPrPage, usePrRoute } from "../../pr-nav";

export default function PullRequestFiles() {
  const { route, cwd, number, client, valid } = usePrRoute();
  if (!valid || !client || !cwd) return <Redirect href="/" />;
  return <PrFiles client={client} cwd={cwd} number={number} onOpenFile={(file) => openPrPage("diff", route, { path: file.path })} />;
}
