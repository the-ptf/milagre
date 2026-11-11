//! Fixture text for the fit check.
//!
//! The first three answers are `LONG_ANSWERS` from `workspace/chat/fixture.rs`, copied because that
//! table is private to the transcript fixture. `ROUTING` adds what the desktop's `Markdown.tsx` routes
//! specially: inline code naming a file (a file-link chip), a Mermaid fence, a nested `markdown`
//! fence, a table and a task list.

pub const DRAFT_ANSWER: &str = r#"I found the cause. The composer keeps its draft in component state, and the Chat view is **remounted** on every switch, so the state goes with it.

Here is what I changed:

1. Moved the draft into `useDraftStore`, keyed by Chat id.
2. Restored the caret position from the store on mount.
3. Kept pasted images as blob URLs until the message is sent, then revoked them.

The store itself is small:

```ts
export const useDraftStore = create<DraftState>((set) => ({
  drafts: {},
  save: (chatId, draft) => set((s) => ({ drafts: { ...s.drafts, [chatId]: draft } })),
  clear: (chatId) => set((s) => {
    const { [chatId]: _, ...rest } = s.drafts;
    return { drafts: rest };
  }),
}));
```

Things I checked:

- Switching between three Chats with drafts in each keeps all three.
- Sending clears only that Chat's draft.
- A draft survives a reload, because the store persists to `localStorage` with a 1 MB cap.

See [the design notes](https://milagre.cloud/design) for why drafts are per Chat and not per Project."#;

pub const FLAKY_ANSWER: &str = r#"The flaky test is `test-onboarding`. It waits for the **Begin** button, but on a cold runner the intro animation takes longer than the 5 s timeout.

### What differs in the failing runs

- They all ran on a fresh runner image (no Electron cache).
- The window appeared 1.8 to 2.4 s later than in passing runs.
- Nothing else: same commit, same Node, same Electron.

### Fix

Wait for the intro's own `ready` event instead of a fixed timeout:

```js
await page.waitForFunction(() => window.__dawn?.ready === true, null, { timeout: 30_000 });
await page.click('button:has-text("Begin")');
```

I ran it 50 times on a cold runner and it passed every time."#;

pub const LIST_ANSWER: &str = r#"Here's how the virtualized list keeps its place.

The list stores a **logical** scroll position, `(item, offset in item)`, not a pixel offset. When items are added below, the item at the top stays the same, so nothing you're reading moves. When you're at the very bottom, the list remembers *that* instead, and new items push the view down with them.

Heights are measured lazily:

- Items in view and in a 600 px band around it are laid out every frame.
- Everything else keeps the height it had when it was last seen, or counts as zero if it was never seen.
  - That is why the scrollbar can grow as you scroll up through old history.
  - `measure_all()` would fix it, at the cost of laying out every item once.

The core of it in Rust:

```rust
let state = ListState::new(items.len(), ListAlignment::Bottom, px(600.));
list(state.clone(), cx.processor(|this, ix, window, cx| this.render_item(ix, window, cx)))
    .size_full()
```

A change to an item that was already measured has to be reported with `splice`, or the old height stays."#;

/// What the desktop's markdown pipeline routes on its own.
pub const ROUTING: &str = r#"The fix is in `apps/desktop/app/src/intro/Dawn.tsx:42`, next to `src/theme/colors.rs`; `npm test` stays plain code.

```mermaid
graph TD
  A[Star lands] --> B{transitionend?}
  B -->|no| C[Timer fallback]
```

```markdown
**Nested** markdown, rendered as markdown.
```

| Platform | Fires `transitionend` |
| -------- | --------------------- |
| macOS    | yes                   |
| Linux    | no                    |

- [x] Timer fallback
- [ ] Check on Wayland"#;

/// A small unified patch for the diff probe (`git diff` output for one file).
pub const PATCH: &str = r#"diff --git a/intro/Dawn.tsx b/intro/Dawn.tsx
--- a/intro/Dawn.tsx
+++ b/intro/Dawn.tsx
@@ -10,7 +10,9 @@ export function Dawn({ onReady }: Props) {
   const star = useRef<HTMLDivElement>(null);
   useEffect(() => {
     const node = star.current;
-    node?.addEventListener("transitionend", onReady);
+    const fallback = window.setTimeout(onReady, 1200);
+    node?.addEventListener("transitionend", onReady, { once: true });
+    return () => window.clearTimeout(fallback);
   }, [onReady]);
   return <div ref={star} className="dawn-star" />;
 }
"#;

pub const OLD_DAWN: &str = r#"export function Dawn({ onReady }: Props) {
  const star = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = star.current;
    node?.addEventListener("transitionend", onReady);
  }, [onReady]);
  return <div ref={star} className="dawn-star" />;
}
"#;

pub const NEW_DAWN: &str = r#"export function Dawn({ onReady }: Props) {
  const star = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = star.current;
    const fallback = window.setTimeout(onReady, 1200);
    node?.addEventListener("transitionend", onReady, { once: true });
    return () => window.clearTimeout(fallback);
  }, [onReady]);
  return <div ref={star} className="dawn-star" />;
}
"#;

/// The transcript as a list of messages, each its own text view.
pub const MESSAGES: [&str; 4] = [DRAFT_ANSWER, FLAKY_ANSWER, LIST_ANSWER, ROUTING];
