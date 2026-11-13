//! Snapshot seeds (`MILAGRE_GPUI_TRANSCRIPT_BLOCKS=diagrams|genui`): replies with the two fenced kinds in them.
//! Never used by the app or the tests' assertions about layout; only by snapshots and `blocks_demo`'s own test.

use crate::workspace::chat::transcript::{Item, Prose};

const FLOWCHART: &str = "```mermaid
flowchart LR
  A[Message] --> B{Fence?}
  B -->|mermaid| C[Diagram]
  B -->|openui| D[Components]
  B -->|other| E[Code block]
  C --> F((Transcript))
  D --> F
  E --> F
```";

const SEQUENCE: &str = "```mermaid
sequenceDiagram
  participant U as User
  participant H as Host
  participant A as Agent
  U->>H: Send message
  H->>A: Start turn
  A-->>H: Stream reply
  H-->>U: Render blocks
```";

const PIE: &str = "```mermaid
pie title Where the time went
  \"Parsing\" : 12
  \"Layout\" : 31
  \"Drawing\" : 57
```";

const STATE: &str = "```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Running: send
  Running --> Idle: done
  Running --> Failed: error
  Failed --> Idle: retry
```";

const BROKEN: &str = "```mermaid
flowchart LR
  A[Start --> B
```";

const UNKNOWN: &str = "```mermaid
not-a-diagram
  A --> B
```";

const GENUI: &str = "```openui
root = Stack([title, summary, note, prs, progress, bars, trend, actions])
title = Heading(\"Three PRs are waiting on you\")
summary = KeyValue([[\"Open\", \"3\"], [\"Failing CI\", \"1\"], [\"Oldest\", \"4 days\"]])
note = Callout(\"One check is red on #390.\", \"warning\", \"Heads up\")
prs = Table([\"PR\", \"Author\", \"CI\"], [[\"#403 Worktree link line\", \"victor\", \"green\"], [\"#390 Sidebar Links\", \"victor\", \"red\"], [\"#388 Archive progress\", \"marcos\", \"green\"]])
progress = Progress(\"Reviewed\", 0.66)
bars = BarChart([\"Mon\", \"Tue\", \"Wed\", \"Thu\", \"Fri\"], [4, 7, 12, 9, 15], \"Merged PRs\")
trend = LineChart([\"Mon\", \"Tue\", \"Wed\", \"Thu\", \"Fri\"], [3, 2, 4, 1, 1], \"Failing checks\")
actions = Stack([approve, later], \"row\")
approve = Button(\"Merge the green ones\", Action([@ToAssistant(\"Merge the PRs whose CI is green\")]))
later = Button(\"Later\", Action([@ToAssistant(\"Not now\")]), \"secondary\")
```";

const SMALL: &str = "```openui
root = Stack([Callout(\"Tests pass on macOS.\", \"success\"), Callout(\"The Linux job was cancelled.\", \"danger\", \"CI\"), Callout(\"A plain note.\")])
```";

fn reply(intro: &str, blocks: &[&str]) -> Item {
    let mut text = intro.to_string();
    for block in blocks {
        text.push_str("\n\n");
        text.push_str(block);
    }
    Item::Prose(Prose::new(text))
}

/// A transcript with a reply per kind of block.
pub fn blocks_demo(kind: &str) -> Vec<Item> {
    match kind {
        "genui" => vec![
            Item::User("What is waiting on me?".into()),
            reply("Three pull requests need you. The table has the detail:", &[GENUI]),
            reply("Short notes read as callouts:", &[SMALL]),
        ],
        _ => vec![
            Item::User("Draw how a reply is routed.".into()),
            reply("Each fence picks its renderer:", &[FLOWCHART]),
            reply("And the exchange behind a send:", &[SEQUENCE, PIE]),
            reply("States, and two that do not draw:", &[STATE, BROKEN, UNKNOWN]),
        ],
    }
}
