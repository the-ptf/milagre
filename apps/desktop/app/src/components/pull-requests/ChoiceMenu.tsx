import { Fragment, useRef, useState, type ReactNode } from "react";
import { Button } from "../primitives/Button";
import { MenuRow, MenuSeparator, Popover } from "../primitives/Popover";

export type MenuChoice<T extends string> = { value: T; label: string; trailing?: string; separatorBefore?: boolean };

/** A toolbar pill that opens a menu of choices with a tick on the current one. */
export function ChoiceMenu<T extends string>({
  label,
  children,
  value,
  choices,
  width = 220,
  onChange,
  ...data
}: {
  label: string;
  children: ReactNode;
  value: T;
  choices: MenuChoice<T>[];
  width?: number;
  onChange: (value: T) => void;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        ref={button}
        {...data}
        variant="secondary"
        shape="pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((shown) => !shown)}
        className="aria-expanded:bg-hover-2"
      >
        {children}
      </Button>
      {open && (
        <Popover anchor={button} align="start" width={width} label={label} onClose={() => setOpen(false)}>
          {choices.map((choice) => (
            <Fragment key={choice.value}>
              {choice.separatorBefore && <MenuSeparator />}
              <MenuRow
                role="menuitemradio"
                checked={choice.value === value}
                title={choice.label}
                trailing={choice.trailing}
                onClick={() => {
                  setOpen(false);
                  if (choice.value !== value) onChange(choice.value);
                }}
              />
            </Fragment>
          ))}
        </Popover>
      )}
    </>
  );
}
