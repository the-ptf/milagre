export type OpenTicket = {
  current(): boolean;
  end(): void;
};

export function createOpenGuard(cancelNavigation: () => void) {
  let ticket = 0;
  let open = false;
  return {
    pending: () => open,
    begin(): OpenTicket | null {
      if (open) return null;
      open = true;
      const mine = ++ticket;
      cancelNavigation();
      return {
        current: () => mine === ticket,
        end() {
          if (mine === ticket) open = false;
        },
      };
    },
    leave() {
      ticket++;
      if (!open) return;
      open = false;
      cancelNavigation();
    },
  };
}
