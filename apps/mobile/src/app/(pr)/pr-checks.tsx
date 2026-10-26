import { PrChecks } from "../../pr-lists";
import { useCloseSheet, usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";

export default function PullRequestChecks() {
  const { route, cwd, number, client, valid, waiting } = usePrRoute();
  const close = useCloseSheet();
  if (!valid || !client || !cwd) return <PrPending number={number} waiting={waiting} />;
  return <PrChecks client={client} cwd={cwd} number={number} chatKey={route.chat} onChat={close} />;
}
