//! Fixture text for the fit check.
//!
//! The first three answers are `LONG_ANSWERS` from `workspace/chat/fixture.rs`. `ROUTING` adds what the desktop's `Markdown.tsx` routes
//! specially: inline code naming a file (a file-link chip), a Mermaid fence, a nested `markdown`
//! fence, a table and a task list.

pub const DRAFT_ANSWER: &str = crate::workspace::chat::fixture::LONG_ANSWERS[0];
pub const FLAKY_ANSWER: &str = crate::workspace::chat::fixture::LONG_ANSWERS[1];
pub const LIST_ANSWER: &str = crate::workspace::chat::fixture::LONG_ANSWERS[2];

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
