//! `--smoke`: drive the real window through a few turns without a person, for evidence on a real account.
//!
//! Each prompt is typed into the composer and sent as a person would (the sink, a fresh client message id); the run
//! is followed in the transcript until its saved reply replaces the live tail. With `--approve`, any approval card is
//! answered with its Allow once button (the card's own decision event). Then a JSON report (items shown, receipts,
//! permission answers, errors, the open Chat) is written to a new 0600 file and the app quits through its normal
//! path, which stops the runtime. No retry: an error or a 180 s turn ends the run with what was seen.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::{App, Entity, WindowHandle};
use gpui_component::Root;
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::chat::transcript::{ApprovalState, Item};
use serde_json::json;

use crate::controller::{LiveController, shown_items};

pub struct Smoke {
    pub prompts: Vec<String>,
    pub approve: bool,
    pub report: PathBuf,
}

const TURN: Duration = Duration::from_secs(180);

pub fn start(smoke: Smoke, window: WindowHandle<Root>, workspace: Entity<Workspace>, controller: Entity<LiveController>, cx: &mut App) {
    cx.spawn(async move |cx| {
        let mut turns = Vec::new();
        let mut failure = None;
        cx.background_executor().timer(Duration::from_millis(800)).await;
        'turns: for prompt in &smoke.prompts {
            let before = cx.update(|cx| controller.read(cx).receipts().len());
            let sent = window.update(cx, |_, window, cx| {
                let composer = workspace.read(cx).chat.read(cx).composer.clone();
                composer.update(cx, |c, cx| {
                    c.set_text(prompt, window, cx);
                    c.submit(window, cx);
                });
            });
            if sent.is_err() {
                failure = Some("the window closed".to_string());
                break;
            }
            let started = Instant::now();
            loop {
                cx.background_executor().timer(Duration::from_millis(200)).await;
                let (receipts, running, errors, items) = cx.update(|cx| {
                    let c = controller.read(cx);
                    let chat = workspace.read(cx).chat.read(cx);
                    let items = chat.transcript.read(cx).items().to_vec();
                    (c.receipts().len(), chat.running.is_some(), c.errors().to_vec(), items)
                });
                if let Some(error) = errors.last() {
                    failure = Some(error.clone());
                    break 'turns;
                }
                if smoke.approve {
                    let waiting: Vec<usize> = items
                        .iter()
                        .enumerate()
                        .filter_map(|(ix, item)| matches!(item, Item::Approval(a) if a.state == ApprovalState::Waiting).then_some(ix))
                        .collect();
                    for ix in waiting {
                        cx.update(|cx| {
                            let transcript = workspace.read(cx).chat.read(cx).transcript.clone();
                            transcript.update(cx, |t, cx| t.resolve(ix, ApprovalState::Allowed, cx));
                        });
                    }
                }
                // A saved reply after this prompt's message, with no run left (a fast turn may never be seen running).
                let asked = items.iter().rposition(|item| matches!(item, Item::User(text) if text.as_ref() == prompt.as_str()));
                let replied = asked.is_some_and(|at| items[at + 1..].iter().any(|item| matches!(item, Item::Prose(p) if !p.streaming)))
                    && matches!(items.last(), Some(Item::Prose(p)) if !p.streaming);
                if receipts > before && !running && replied {
                    turns.push(json!({"prompt": prompt, "seconds": started.elapsed().as_secs_f32(), "items": shown_items(&items)}));
                    break;
                }
                if started.elapsed() > TURN {
                    failure = Some(format!("no saved reply within {} s", TURN.as_secs()));
                    break 'turns;
                }
            }
        }
        let report = cx.update(|cx| {
            let c = controller.read(cx);
            let items = workspace.read(cx).chat.read(cx).transcript.read(cx).items().to_vec();
            json!({
                "passed": failure.is_none() && turns.len() == smoke.prompts.len(),
                "failure": failure,
                "openChat": c.open_key(),
                "turns": turns,
                "finalItems": shown_items(&items),
                "receipts": c.receipts().iter().map(|(id, r)| json!({"clientMessageId": id, "receipt": r})).collect::<Vec<_>>(),
                "permissionAnswers": c.decisions(),
                "errors": c.errors(),
            })
        });
        write_report(&smoke.report, &report);
        eprintln!("live: smoke report {}", smoke.report.display());
        cx.update(|cx| cx.quit());
    })
    .detach();
}

fn write_report(path: &std::path::Path, report: &serde_json::Value) {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
        Ok(mut file) => {
            let _ = writeln!(file, "{}", serde_json::to_string_pretty(report).unwrap_or_default());
        }
        Err(error) => eprintln!("live: could not write {}: {error}; report: {report}", path.display()),
    }
}
