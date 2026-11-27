import { CONNECTOR_PRESETS, connectorPreset, type ConnectorSummary } from "@milagre/shared/connectors";

const LINEAR_ICON = CONNECTOR_PRESETS.find((preset) => preset.id === "linear")?.iconPath;

export const isBuiltIn = (connector: ConnectorSummary) => connector.kind === "linear" || connector.kind === "email";
export const connectorIcon = (connector: ConnectorSummary) => (connector.kind === "linear" ? LINEAR_ICON : connectorPreset(connector)?.iconPath);
export const toolPrefix = (connector: ConnectorSummary) =>
  connector.kind === "linear" ? "linear_" : connector.kind === "email" ? "email_" : `${connector.id}__`;
/** The preset ids already on this computer, so the gallery can mark them Added. */
export const addedPresets = (connectors: readonly ConnectorSummary[] | null): ReadonlySet<string> =>
  new Set(
    (connectors ?? [])
      .map((connector) => (connector.kind === "linear" ? "linear" : connector.kind === "email" ? "email" : connectorPreset(connector)?.id))
      .filter((id): id is string => Boolean(id)),
  );
