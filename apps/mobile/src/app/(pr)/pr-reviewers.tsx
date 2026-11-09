import { PrPicker } from "../../pr-lists";
import { usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";

export default function PullRequestReviewers() {
  const { cwd, number, client, valid, waiting } = usePrRoute();
  if (!valid || !client || !cwd) return <PrPending number={number} waiting={waiting} />;
  return <PrPicker client={client} cwd={cwd} number={number} kind="reviewers" />;
}
