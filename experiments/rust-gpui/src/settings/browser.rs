//! Browser Settings section (`BrowserSettings` in `Settings.tsx`).

use gpui::{App, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::group::{SettingRow, SettingsGroup, page_header, slug};
use super::store::{OpenLinksIn, SettingsStore};
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, Select, SelectOption};

pub fn render_browser(computers: &[(String, String, bool)], highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let theme = *cx.theme();
    let store = cx.global::<SettingsStore>().clone();
    let hl_shared = highlighted.map(|s| SharedString::from(s.to_owned()));

    // Links group
    let links_select = Select::new(
        "browser-open-links-in",
        store.open_links_in.as_str(),
        [SelectOption::new("browser", "Default browser"), SelectOption::new("panel", "Browser panel")],
    )
    .on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| s.open_links_in = OpenLinksIn::parse(val));
    });

    let links_group = SettingsGroup::new().title("Links").highlighted_row(hl_shared.clone()).row(
        SettingRow::new("Open links in")
            .description("Where web links open when you click them: links in the agent's replies and the servers the Chat runs.")
            .highlighted(highlighted)
            .control(links_select),
    );

    // Sign-ins group (`local` + any paired computers)
    let mut sessions: Vec<(String, Option<String>)> = vec![("local".to_string(), None)];
    for (id, name, _) in computers {
        sessions.push((id.clone(), Some(name.clone())));
    }
    let multi = sessions.len() > 1;

    let rows = sessions.into_iter().map(|(session_id, comp_name)| {
        let label = if multi { comp_name.clone().unwrap_or_else(|| "This Mac".to_string()) } else { "Sign out".to_string() };
        let description = match &comp_name {
            Some(name) => {
                format!("Signs the Browser panel pages of {name}'s Chats out of every site, and clears their cookies and site data.")
            }
            None => {
                "Signs the Browser panel pages of this Mac's Chats out of every site, and clears their cookies and site data.".to_string()
            }
        };
        let signed_out = store.signed_out_sessions.contains(&session_id);
        let btn_id = format!("browser-sign-out-{}", slug(&session_id));
        let control = if signed_out {
            div()
                .debug_selector(move || format!("{btn_id}-done"))
                .px(px(10.0))
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child("Signed out")
                .into_any_element()
        } else {
            let sid = session_id.clone();
            Button::new(btn_id, "Sign out")
                .variant(ButtonVariant::Secondary)
                .size(ButtonSize::S28)
                .on_click(move |_, _, cx| {
                    let sid = sid.clone();
                    cx.update_global::<SettingsStore, _>(|s, _| {
                        s.signed_out_sessions.insert(sid);
                    });
                })
                .into_any_element()
        };

        let row_hl = if highlighted == Some("Sign out") && session_id == "local" { Some(label.as_str()) } else { highlighted };

        SettingRow::new(label.clone()).description(description).highlighted(row_hl).control(control).into_any_element()
    });

    let sign_ins_group = SettingsGroup::new().title("Sign-ins").highlighted_row(hl_shared).rows(rows);

    div()
        .debug_selector(|| "settings-section-browser".into())
        .flex()
        .flex_col()
        .child(page_header("Browser", Some("Web links and the Browser panel."), cx))
        .child(links_group)
        .child(sign_ins_group)
}
