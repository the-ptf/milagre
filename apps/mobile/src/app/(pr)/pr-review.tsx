import { router } from "expo-router";
import { PrReviewForm } from "../../pr-lists";
import { usePrRoute } from "../../pr-nav";
import { PrPending } from "../../pr-pending";

export default function PullRequestReview() {
  const { cwd, number, client, valid, waiting } = usePrRoute();
  if (!valid || !client || !cwd) return <PrPending number={number} waiting={waiting} />;
  return <PrReviewForm client={client} cwd={cwd} number={number} onDone={() => router.back()} />;
}
