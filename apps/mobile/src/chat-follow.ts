import { useCallback, useMemo, useRef, type RefObject } from "react";
import { Platform } from "react-native";
import type Reanimated from "react-native-reanimated";

export type FollowState = {
  following: boolean;
  scrollingToBottom: boolean;
  dragging: boolean;
  scrolledFirstRow: number | undefined;
};

export type FollowScroll = {
  offset: number;
  previous: number;
  distance: number;
  firstRowId: number | undefined;
};

export type FollowStep = Omit<FollowState, "dragging"> & {
  toBottom: boolean;
  stop: boolean;
};

/** What one scroll event does to the transcript's follow state: whether it still follows the end, and whether to jump there. */
export function nextFollow(state: FollowState, event: FollowScroll): FollowStep {
  const { following, scrollingToBottom, dragging, scrolledFirstRow } = state;
  const { offset, previous, distance, firstRowId } = event;
  if (scrollingToBottom) return { following, scrollingToBottom: distance > 1, scrolledFirstRow, toBottom: false, stop: true };
  const rowsLeftTop = scrolledFirstRow !== firstRowId;
  if (rowsLeftTop && !dragging && following && distance > 1) return { following, scrollingToBottom, scrolledFirstRow: firstRowId, toBottom: true, stop: true };
  return {
    following: following ? distance < 120 : offset > previous && distance <= 1,
    scrollingToBottom,
    scrolledFirstRow: firstRowId,
    toBottom: false,
    stop: false,
  };
}

/** The transcript's follow state and its jump to the end, with the drag handlers that pause following. */
export function useTranscriptFollow(scroll: RefObject<Reanimated.ScrollView | null>) {
  const following = useRef(true);
  const scrollingToBottom = useRef(false);
  const dragging = useRef(false);
  const endFrame = useRef<number | undefined>(undefined);
  const cancelEndFrame = useCallback(() => {
    if (endFrame.current !== undefined) cancelAnimationFrame(endFrame.current);
    endFrame.current = undefined;
  }, []);
  const scrollToBottom = useCallback(
    (animated: boolean) => {
      scrollingToBottom.current = true;
      if (Platform.OS !== "android") {
        scroll.current?.scrollToEnd({ animated });
        return;
      }
      // Android runs a view command ahead of the mount it arrives with, so a jump asked for from onContentSizeChange
      // stops at the end the content had before it grew. Timers fire after that frame's mount, so the jump a frame
      // later reaches the grown end.
      cancelEndFrame();
      endFrame.current = requestAnimationFrame(() => {
        endFrame.current = undefined;
        scrollingToBottom.current = true;
        scroll.current?.scrollToEnd({ animated });
      });
    },
    [cancelEndFrame, scroll],
  );
  const dragHandlers = useMemo(
    () => ({
      onScrollBeginDrag: () => {
        dragging.current = true;
        scrollingToBottom.current = false;
        cancelEndFrame();
        following.current = false;
      },
      onScrollEndDrag: () => {
        dragging.current = false;
      },
      onMomentumScrollBegin: () => {
        if (!scrollingToBottom.current) dragging.current = true;
      },
      onMomentumScrollEnd: () => {
        dragging.current = false;
      },
    }),
    [cancelEndFrame],
  );
  return { following, scrollingToBottom, dragging, cancelEndFrame, scrollToBottom, dragHandlers };
}
