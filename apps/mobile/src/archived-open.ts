/**
 * Opening one Chat from the Archived list, which may first switch the phone to another computer. Only one open runs at a
 * time and it belongs to the page: leaving the page, or anything else starting a navigation, makes a pending open stale, and
 * a stale open must neither switch computers nor navigate.
 */
export type OpenTicket = {
  /** False once the page was left or the open was replaced: the caller must stop touching the session and the router. */
  current(): boolean;
  /** The open is over (done or failed); lets the next one start. A stale ticket's end changes nothing. */
  end(): void;
};

export function createOpenGuard(cancelNavigation: () => void) {
  let ticket = 0;
  let open = false;
  return {
    /** Whether an open is pending. Synchronous, so two taps in one frame cannot both start. */
    pending: () => open,
    /** Starts an open and cancels the session's pending navigations; null while another open is pending. */
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
    /** The page was left: a pending open goes stale and the session stops the switch it had under way. */
    leave() {
      ticket++;
      if (!open) return;
      open = false;
      cancelNavigation();
    },
  };
}
