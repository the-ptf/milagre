//! Fixture transcript: a long, deterministic history ending in the conversation on the first screen.
//!
//! The last five items are the screen the spike is judged on (a user message, its activity, a prose
//! answer, an edit, and an approval waiting on Run the onboarding check; the running row under them is
//! `ChatView`'s, not an item). Above
//! them, `history` generates turns from a fixed seed: user messages short and long, activity rows,
//! tool rows, settled approvals and markdown answers, every fourth one long with lists and code.

use gpui::SharedString;

use crate::data::{ChatStep, Millis, StepKind, StepStatus};
use crate::workspace::chat::transcript::{Activity, Approval, ApprovalState, Entry, Item, Prose, StepItem};

/// The clock the fixture's running steps count from (the transcript has no ticking clock yet).
pub const NOW: Millis = 1_800_000_000_000;

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
        Item::Activity(first_activity()),
        Item::Prose(Prose::new(
            "The hang is in the Dawn intro. On Linux the compositor never fires `transitionend` for the star layer, so \
             **Begin** stays disabled. I'm adding a timer fallback and a check for it.",
        )),
        Item::Step(StepItem::new(edit_step("first-edit", "intro/Dawn.tsx", 12, 3, 400), NOW)),
        Item::Approval(Approval {
            step: ChatStep {
                id: "approval-step".into(),
                kind: Some(StepKind::Shell),
                title: "Run the onboarding check".into(),
                ..ChatStep::default()
            },
            command: "npm test -- --only test-onboarding".into(),
            state: ApprovalState::Waiting,
        }),
    ]
}

/// A finished step that took `ms`, ending at `end`.
fn done(id: impl Into<SharedString>, kind: StepKind, title: impl Into<SharedString>, end: Millis, ms: u64) -> ChatStep {
    ChatStep {
        id: id.into(),
        kind: Some(kind),
        title: title.into(),
        started_at: Some(end - ms as Millis),
        ended_at: Some(end),
        duration_ms: Some(ms),
        ..ChatStep::default()
    }
}

/// An edit with its unified diff and counts, as the host keeps them.
fn edit_step(id: &str, path: &str, added: u32, removed: u32, ms: u64) -> ChatStep {
    let mut diff = format!("--- a/{path}\n+++ b/{path}\n@@ -40,{removed} +40,{added} @@\n");
    for n in 0..removed.min(6) {
        diff.push_str(&format!("-  const old{n} = waitFor(\"transitionend\");\n"));
    }
    for n in 0..added.min(12) {
        diff.push_str(&format!("+  const fallback{n} = window.setTimeout(onReady, 1200);\n"));
    }
    ChatStep {
        summary: Some(format!("+{added} -{removed}").into()),
        detail: Some(diff.into()),
        file: Some(path.to_string().into()),
        ..done(id.to_string(), StepKind::Edit, format!("Edited `{path}`"), NOW, ms)
    }
}

/// "Thought for 12s · read 6 files · ran 2 commands", over 41s: the first screen's folded reply.
fn first_activity() -> Activity {
    let start = NOW - 41_000;
    let mut entries = vec![Entry::Step(ChatStep {
        detail: Some("The star layer waits for a transition that some compositors skip. A timer would cover it.".into()),
        ..done("t1", StepKind::Thinking, "Thought for 12s", start + 12_000, 12_000)
    })];
    for (n, path) in PATHS.iter().take(6).enumerate() {
        entries.push(Entry::Step(done(
            format!("r{n}"),
            StepKind::Read,
            format!("Read `{path}`"),
            start + 14_000 + n as Millis * 1_500,
            300,
        )));
    }
    for (n, command) in ["npm run typecheck", "npm test -- --unit"].iter().enumerate() {
        entries.push(Entry::Step(ChatStep {
            input: Some((*command).into()),
            detail: Some(format!("$ {command}\nok").into()),
            ..done(format!("c{n}"), StepKind::Shell, format!("Ran `{command}`"), start + 30_000 + n as Millis * 5_500, 5_000)
        }));
    }
    Activity::new(entries, NOW)
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
    let start = NOW - 3_600_000 + turn as Millis * 1_000;
    let mut entries = vec![Entry::Step(done(
        format!("t{turn}"),
        StepKind::Thinking,
        format!("Thought for {thought}s"),
        start + thought as Millis * 1_000,
        thought as u64 * 1_000,
    ))];
    for n in 0..files {
        let path = PATHS[(turn + n) % PATHS.len()];
        entries.push(Entry::Step(done(
            format!("r{turn}-{n}"),
            StepKind::Read,
            format!("Read `{path}` {n}"),
            start + 20_000 + n as Millis * 800,
            300,
        )));
    }
    for n in 0..commands {
        let command = COMMANDS[(turn + n) % COMMANDS.len()];
        entries.push(Entry::Step(done(
            format!("c{turn}-{n}"),
            StepKind::Shell,
            format!("Ran `{command}`"),
            start + 60_000 + n as Millis * 4_000,
            3_000,
        )));
    }
    items.push(Item::Activity(Activity::new(entries, NOW)));

    for n in 0..1 + rng.below(4) {
        items.push(Item::Step(StepItem::new(tool(turn * 10 + n, rng), NOW)));
    }
    if turn % 7 == 3 {
        let (label, command) = APPROVALS[rng.below(APPROVALS.len())];
        let state = if rng.below(5) == 0 { ApprovalState::Denied } else { ApprovalState::Allowed };
        items.push(Item::Approval(Approval {
            step: done(format!("a{turn}"), StepKind::Shell, label, NOW, 2_000 + rng.below(200_000) as u64),
            command: command.into(),
            state,
        }));
    }

    let source = if turn % 4 == 1 { LONG_ANSWERS[rng.below(LONG_ANSWERS.len())] } else { rng.pick(SHORT_ANSWERS) };
    items.push(Item::Prose(Prose::new(source)));
    if rng.below(3) == 0 {
        items.push(Item::Step(StepItem::new(tool(turn * 10 + 9, rng), NOW)));
        items.push(Item::Prose(Prose::new(rng.pick(SHORT_ANSWERS))));
    }
}

fn tool(n: usize, rng: &mut Rng) -> ChatStep {
    let path = rng.pick(PATHS);
    let ms = 100 + rng.below(4000) as u64;
    let id = format!("tool-{n}");
    match rng.below(4) {
        0 => ChatStep { file: Some(path.into()), ..done(id, StepKind::Read, format!("Read `{path}`"), NOW, ms) },
        1 => edit_step(&id, path, 1 + rng.below(8) as u32, rng.below(6) as u32, ms),
        2 => {
            let command = rng.pick(COMMANDS);
            ChatStep {
                input: Some(command.into()),
                detail: Some(format!("$ {command}\nfinished").into()),
                ..done(id, StepKind::Shell, format!("Ran `{command}`"), NOW, ms)
            }
        }
        _ => {
            let query = rng.pick(SEARCHES);
            ChatStep {
                summary: Some("3 results".into()),
                detail: Some(format!("{path}:12: {query}\n{path}:48: {query}\n{path}:90: {query}").into()),
                ..done(id, StepKind::Search, format!("Searched for `{query}`"), NOW, ms)
            }
        }
    }
}

/// One of every kind of row the app draws, finished: thinking, read, search, edit, write, command, a failed
/// command, Linear and other MCP tools, a web fetch, a subagent and the to-do list.
pub fn every_kind() -> Vec<ChatStep> {
    let at = NOW - 20_000;
    let mcp = |id: &str, server: &str, name: &str, title: &str, input: &str, detail: &str, ms: u64| ChatStep {
        source_name: Some(name.to_string().into()),
        source_server: Some(server.to_string().into()),
        input: Some(input.to_string().into()),
        detail: Some(detail.to_string().into()),
        ..done(id.to_string(), StepKind::Other, title.to_string(), at, ms)
    };
    vec![
        ChatStep {
            detail: Some("The star layer waits for `transitionend`. Wayland compositors skip it when the layer is not repainted, so a timer is the safe fallback.".into()),
            ..done("k-think", StepKind::Thinking, "Thought for 12s", at, 12_000)
        },
        ChatStep { file: Some("apps/desktop/app/src/intro/Dawn.tsx".into()), ..done("k-read", StepKind::Read, "Read `apps/desktop/app/src/intro/Dawn.tsx`", at, 300) },
        ChatStep {
            summary: Some("3 results".into()),
            detail: Some("intro/Dawn.tsx:42: transitionend\nintro/Star.tsx:18: transitionend\nlib/motion.ts:7: transitionend".into()),
            ..done("k-search", StepKind::Search, "Searched for `transitionend`", at, 900)
        },
        edit_step("k-edit", "intro/Dawn.tsx", 12, 3, 400),
        ChatStep { summary: Some("+24 -0".into()), file: Some("intro/fallback.ts".into()), ..done("k-write", StepKind::Edit, "Wrote `intro/fallback.ts`", at, 200) },
        ChatStep {
            input: Some("npm test -- --only test-onboarding".into()),
            summary: Some("12 passed".into()),
            detail: Some("$ npm test -- --only test-onboarding\n> milagre@1.0.0 test\n# pass 12\n# fail 0".into()),
            ..done("k-shell", StepKind::Shell, "Ran `npm test -- --only test-onboarding`", at, 4_200)
        },
        ChatStep {
            status: StepStatus::Failed,
            summary: Some("2 failed · 10 passed".into()),
            error: Some("expected onReady to be called once, was called twice".into()),
            input: Some("npm test -- --unit".into()),
            detail: Some("$ npm test -- --unit\nnot ok 3 - fallback fires once\n# fail 2".into()),
            ..done("k-failed", StepKind::Shell, "Ran `npm test -- --unit`", at, 6_000)
        },
        mcp("k-linear", "Linear", "get_issue", "Used `get_issue` from Linear", "{\"identifier\":\"ENG-412\"}", "{\"title\":\"Intro hangs on Linux\"}", 700),
        mcp("k-fetch", "web", "fetch", "Fetched `https://developer.mozilla.org/en-US/docs/Web/API/Element/transitionend_event`", "{\"url\":\"https://developer.mozilla.org\"}", "transitionend fires when a CSS transition has completed.", 1_400),
        mcp("k-agent", "claude", "Task", "Started subagent `Explore`", "{\"prompt\":\"find every transitionend listener\"}", "Found 3 listeners.", 8_000),
        mcp("k-todo", "claude", "TodoWrite", "Updated to-do list", "{\"todos\":3}", "3 items", 100),
    ]
}

/// The snapshot of the activity package (`MILAGRE_GPUI_TRANSCRIPT_ACTIVITY=1`): a folded reply, an expanded one
/// with every kind of row (some open), a standalone running tool and a streaming reply.
pub fn activity_demo() -> Vec<Item> {
    let mut items = vec![
        Item::User("Fix the intro hang, then run the checks.".into()),
        Item::Activity(first_activity()),
        Item::Prose(Prose::new("Fixed. The details of what ran:")),
    ];
    let entries = every_kind().into_iter().map(Entry::Step).collect();
    items.push(Item::Activity(Activity::new(entries, NOW).with_open_rows(&["k-edit", "k-failed", "k-linear"])));
    items.push(Item::Prose(Prose::new("The fallback fires once; the failing run is the old listener.")));
    items.push(Item::Step(StepItem::new(
        ChatStep {
            id: "k-running".into(),
            kind: Some(StepKind::Shell),
            title: "Ran `npm run typecheck`".into(),
            status: StepStatus::Running,
            started_at: Some(NOW - 8_000),
            ..ChatStep::default()
        },
        NOW,
    )));
    items
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
