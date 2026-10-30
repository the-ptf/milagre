import { PillButton } from "./pill-button";

/**
 * @deprecated Use `PillButton`. The old native (@expo/ui) Button's props, drawn as a regular PillButton: filled is
 * primary, `secondary` and `destructive` are secondary (destructive with a redInk label). Kept until its call sites move.
 */
export function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
  loading = false,
  destructive = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  loading?: boolean;
  destructive?: boolean;
}) {
  return (
    <PillButton
      title={title}
      onPress={onPress}
      disabled={disabled}
      loading={loading}
      variant={secondary || destructive ? "secondary" : "primary"}
      destructive={destructive}
    />
  );
}
