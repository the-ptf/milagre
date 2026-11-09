// Metro turns Pele's browser build into its text (scripts/text-module-transformer.cjs).
declare module "pele/global" {
  const source: string;
  export default source;
}
