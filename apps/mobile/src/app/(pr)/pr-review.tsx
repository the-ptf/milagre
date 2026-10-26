import { Redirect, router } from "expo-router";
import { PrReviewForm } from "../../pr-lists";
import { usePrRoute } from "../../pr-nav";

export default function PullRequestReview() {
  const { cwd, number, client, valid } = usePrRoute();
  if (!valid || !client || !cwd) return <Redirect href="/" />;
  return <PrReviewForm client={client} cwd={cwd} number={number} onDone={() => router.back()} />;
}
