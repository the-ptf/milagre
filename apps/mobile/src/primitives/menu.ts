import { type ColorValue } from "react-native";
import { type NativePickerIconName } from "../native-picker-icon";

type MenuItem = {
  id: string;
  title: string;
  systemImage?: string;
  icon?: NativePickerIconName;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  subtitle?: string;
  /** A submenu: the item opens these choices instead of being one (a Chat's Snooze until). */
  submenu?: MenuItem[];
};

export type MenuSection = { title?: string; items: MenuItem[] };

export type NativeMenuTrigger = {
  title?: string;
  icon?: NativePickerIconName;
  systemImage: string;
  disabled?: boolean;
  maxWidth?: number;
  minHeight?: number;
  fontSize?: number;
  showIcon?: boolean;
  iconSize?: number;
  menuTint?: ColorValue;
  rotation?: number;
};
