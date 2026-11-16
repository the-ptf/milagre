import { createElement, lazy, Suspense, type ComponentType } from "react";

export function lazyView<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  const Loaded = lazy(() => load().then((component) => ({ default: component })));
  const View = (props: Props) => <Suspense fallback={null}>{createElement(Loaded as ComponentType<Props>, props)}</Suspense>;
  View.preload = () => void load().catch(() => {});
  return View;
}
