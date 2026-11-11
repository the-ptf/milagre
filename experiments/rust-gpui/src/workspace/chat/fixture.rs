//! Fixture transcript: a long, deterministic history ending in the conversation on the first screen.
//!
//! The last five items are the screen the spike is judged on (a user message, its activity, a prose
//! answer, an edit, and an approval waiting on Run the onboarding check; the running row under them is
//! `ChatView`'s, not an item). Above
//! them, `history` generates turns from a fixed seed: user messages short and long, activity rows,
//! tool rows, settled approvals and markdown answers, every fourth one long with lists and code.

use gpui::SharedString;

use crate::workspace::chat::transcript::{Activity, Approval, ApprovalState, Item, Prose, Tool, ToolKind};

/// Items in the default transcript.
pub const HISTORY_ITEMS: usize = 2000;

/// `total` items: generated history, then the first screen.
pub fn transcript(total: usize) -> Vec<Item> {
    let tail = first_screen();
    let mut items = history(total.saturating_sub(tail.len()));
    items.extend(tail);
    items
}

/// The conversation on screen when the Chat opens.
pub fn first_screen() -> Vec<Item> {
    vec![
        Item::User("The intro hangs on Linux after the star lands. Find it, fix it and open a PR.".into()),
        Item::Activity(Activity {
            marks: vec![ToolKind::Think, ToolKind::Read, ToolKind::Command],
            summary: "Thought for 12s · read 6 files · ran 2 commands".into(),
            duration: "41s".into(),
        }),
        Item::Prose(Prose::new(
            "The hang is in the Dawn intro. On Linux the compositor never fires `transitionend` for the star layer, so \
             **Begin** stays disabled. I'm adding a timer fallback and a check for it.",
        )),
        Item::Tool(Tool {
            kind: ToolKind::Edit,
            label: "Edit intro/Dawn.tsx".into(),
            added: Some(12),
            removed: Some(3),
            duration: "0.4s".into(),
        }),
        Item::Approval(Approval {
            tool: Tool {
                kind: ToolKind::Command,
                label: "Run the onboarding check".into(),
                added: None,
                removed: None,
                duration: "".into(),
            },
            command: "npm test -- --only test-onboarding".into(),
            state: ApprovalState::Waiting,
        }),
    ]
}

/// A small deterministic generator (64-bit LCG), so every run and test sees the same history.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a>(&mut self, options: &[&'a str]) -> &'a str {
        options[self.below(options.len())]
    }
}

/// Exactly `count` items of past turns.
pub fn history(count: usize) -> Vec<Item> {
    let mut rng = Rng(0x6d69_6c61_6772_6521);
    let mut items = Vec::with_capacity(count + 16);
    let mut turn = 0;
    while items.len() < count {
        push_turn(turn, &mut rng, &mut items);
        turn += 1;
    }
    items.truncate(count);
    items
}

fn push_turn(turn: usize, rng: &mut Rng, items: &mut Vec<Item>) {
    items.push(Item::User(rng.pick(USER_MESSAGES).into()));

    let thought = 3 + rng.below(40);
    let files = 1 + rng.below(14);
    let commands = rng.below(5);
    let mut marks = vec![ToolKind::Think, ToolKind::Read];
    if commands > 0 {
        marks.push(ToolKind::Command);
    }
    let summary = match commands {
        0 => format!("Thought for {thought}s · read {files} files"),
        1 => format!("Thought for {thought}s · read {files} files · ran 1 command"),
        n => format!("Thought for {thought}s · read {files} files · ran {n} commands"),
    };
    items.push(Item::Activity(Activity { marks, summary: summary.into(), duration: duration(rng) }));

    for _ in 0..1 + rng.below(4) {
        items.push(Item::Tool(tool(rng)));
    }
    if turn % 7 == 3 {
        let (label, command) = APPROVALS[rng.below(APPROVALS.len())];
        let state = if rng.below(5) == 0 { ApprovalState::Denied } else { ApprovalState::Allowed };
        items.push(Item::Approval(Approval {
            tool: Tool { kind: ToolKind::Command, label: label.into(), added: None, removed: None, duration: duration(rng) },
            command: command.into(),
            state,
        }));
    }

    let source = if turn % 4 == 1 { LONG_ANSWERS[rng.below(LONG_ANSWERS.len())] } else { rng.pick(SHORT_ANSWERS) };
    items.push(Item::Prose(Prose::new(source)));
    if rng.below(3) == 0 {
        items.push(Item::Tool(tool(rng)));
        items.push(Item::Prose(Prose::new(rng.pick(SHORT_ANSWERS))));
    }
}

fn duration(rng: &mut Rng) -> SharedString {
    let seconds = 2 + rng.below(240);
    if seconds < 60 { format!("{seconds}s").into() } else { format!("{}m {:02}s", seconds / 60, seconds % 60).into() }
}

fn tool(rng: &mut Rng) -> Tool {
    let path = rng.pick(PATHS);
    let tenths = 1 + rng.below(40);
    let duration: SharedString = format!("{}.{}s", tenths / 10, tenths % 10).into();
    match rng.below(4) {
        0 => Tool { kind: ToolKind::Read, label: format!("Read {path}").into(), added: None, removed: None, duration },
        1 => Tool {
            kind: ToolKind::Edit,
            label: format!("Edit {path}").into(),
            added: Some(1 + rng.below(80) as u32),
            removed: Some(rng.below(30) as u32),
            duration,
        },
        2 => Tool { kind: ToolKind::Command, label: format!("Ran {}", rng.pick(COMMANDS)).into(), added: None, removed: None, duration },
        _ => Tool {
            kind: ToolKind::Search,
            label: format!("Searched for {}", rng.pick(SEARCHES)).into(),
            added: None,
            removed: None,
            duration,
        },
    }
}

const PATHS: &[&str] = &[
    "apps/desktop/src/chat/Transcript.tsx",
    "apps/desktop/src/composer/Composer.tsx",
    "apps/mobile/src/screens/ChatScreen.tsx",
    "packages/shared/src/chats.ts",
    "apps/relay/src/room.ts",
    "intro/Dawn.tsx",
    "apps/desktop/electron/main/window.ts",
    "packages/daemon/src/approvals.rs",
    "DESIGN.md",
    "apps/site/src/pages/index.astro",
];

const COMMANDS: &[&str] = &["npm run typecheck", "npm test -- --unit", "npm run lint", "git status", "cargo test", "gh pr view 1013"];

const SEARCHES: &[&str] = &["transitionend", "scrollToBottom", "useApproval", "relay backoff", "chat-size", "ListState"];

const APPROVALS: &[(&str, &str)] = &[
    ("Run the unit tests", "npm test -- --unit"),
    ("Push the branch", "git push -u origin fix/dawn-linux-hang"),
    ("Open the pull request", "gh pr create --fill --draft"),
    ("Delete the build cache", "rm -rf apps/desktop/.vite"),
];

const USER_MESSAGES: &[&str] = &[
    "Why does the sidebar jump when a Chat finishes?",
    "Run the unit tests and fix whatever fails.",
    "The composer loses its draft when I switch Chats and come back. Can you find where the draft is dropped and keep it per Chat, including images I pasted?",
    "Make the approval buttons 28px like DESIGN.md says.",
    "Check the relay logs for the 4404 storm from last night and tell me if the backoff is working.",
    "ok",
    "Can you explain how the list keeps its scroll position when new messages arrive while I'm reading an older answer?",
    "Ship it.",
    "Rename the setting to Show stats and keep the old key working for one release.",
    "This test is flaky on CI only, about one run in ten. Look at the last twenty runs and tell me what is different about the failing ones before changing anything.",
    "Use the tokens from theme.rs, not raw hex.",
    "What would it take to support Linux?",
];

const SHORT_ANSWERS: &[&str] = &[
    "Done. The draft is now stored per Chat in `drafts.ts`, and switching back restores it with the caret where you left it.",
    "All **412** unit tests pass. I fixed one snapshot that still had the old label.",
    "The sidebar jumps because the row height changes when the running ring is replaced by the unread dot. I made both 8px.",
    "The backoff works: after the first refusal the client waits 5 minutes, and the Room stays asleep.",
    "I couldn't reproduce it locally. On CI the failing runs all start with a cold cache, which delays the window by about 2s.",
    "Renamed. The old key is read once on startup and migrated, then removed.",
    "Linux needs three things: a tray icon fallback, the AppImage build, and `xdg-open` for links. None of them is large.",
    "Yes. The list keeps the item at the top of the viewport fixed, so new items below don't move what you're reading.",
];

// Raw strings, so code indentation and nested list indentation survive.
pub(crate) const LONG_ANSWERS: &[&str] = &[
    r#"I found the cause. The composer keeps its draft in component state, and the Chat view is **remounted** on every switch, so the state goes with it.

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

See [the design notes](https://milagre.cloud/design) for why drafts are per Chat and not per Project."#,
    r#"The flaky test is `test-onboarding`. It waits for the **Begin** button, but on a cold runner the intro animation takes longer than the 5 s timeout.

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

I ran it 50 times on a cold runner and it passed every time."#,
    r#"Here's how the virtualized list keeps its place.

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

A change to an item that was already measured has to be reported with `splice`, or the old height stays."#,
    r#"Linux support is mostly packaging. The app itself already runs; what's missing is around it.

1. **Packaging**: an AppImage and a `.deb`, built in CI on Ubuntu 22.04.
2. **Tray**: `libappindicator` is not everywhere, so the tray icon needs a fallback to a normal window menu.
3. **Links**: `shell.openExternal` works, but only if `xdg-open` is installed; we should say so when it isn't.
4. **Notifications**: libnotify works on GNOME and KDE. On others we fall back to the in-app toast.

A rough check of what the build needs:

```sh
sudo apt-get install -y libgtk-3-dev libnss3 libxss1 libasound2 libnotify-bin xdg-utils
npm run build:linux -- --x64 --arm64
```

I'd start with packaging and links, since everything else degrades without breaking."#,
    r#"## Why the intro hangs on Linux

The star layer waits for `transitionend`, which some compositors never send. The fix is in `apps/desktop/app/src/intro/Dawn.tsx:42`, with the timing in `src/theme/metrics.rs`; `npm test` covers it.

### What fires where

| Platform | Fires `transitionend` | Fallback needed |
| -------- | --------------------- | --------------- |
| macOS    | yes                   | no              |
| Windows  | yes                   | no              |
| Linux    | sometimes             | yes             |

1. Start a **1.2 s** timer when the star mounts.
2. Clear it when `transitionend` arrives first.
3. Call `onReady` from whichever comes first.

```ts
useEffect(() => {
  const fallback = window.setTimeout(onReady, 1200); // compositors that never fire it
  node?.addEventListener("transitionend", onReady, { once: true });
  return () => window.clearTimeout(fallback);
}, [onReady]);
```

> Wayland needs a check by hand: the test runner uses X11.

See [the compositor notes](https://milagre.cloud/design) for the rest."#,
];
