import { type ColorValue } from "react-native";
import { type NativePickerIconName } from "../native-picker-icon";

export type MenuItem = {
  id: string;
  title: string;
  systemImage?: string;
  icon?: NativePickerIconName;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  subtitle?: string;
};

export type MenuSection = { title?: string; items: MenuItem[] };

export type NativeMenuTrigger = {
  title?: string;
  icon?: NativePickerIconName;
  systemImage: string;
  disabled?: boolean;
  maxWidth?: number;
  showIcon?: boolean;
  iconSize?: number;
  menuTint?: ColorValue;
  rotation?: number;
};
