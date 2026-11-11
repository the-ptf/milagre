//! After `apps/desktop/app/src/lib/question-answers.ts`: what the user has picked and typed on a question card, and
//! the rules that turn it into answers. Images attached to an answer are not ported (the card's image button is inert).

use std::collections::HashMap;

use crate::data::AnsweredQuestion;
use crate::logic::activity::subchat_states::AgentQuestion;

/// `QuestionDraft`: the picks and typed answer for one question.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub picked: Vec<String>,
    pub typed: String,
    /// Whether the typed answer (the "Other" row) is chosen. `None` on a draft that never set it: a typed answer then
    /// counts.
    pub other: Option<bool>,
}

/// Drafts by question id.
pub type Drafts = HashMap<String, Draft>;

pub fn draft_of(drafts: &Drafts, question_id: &str) -> Draft {
    drafts.get(question_id).cloned().unwrap_or_default()
}

/// `pickOption`: a single-choice question keeps only that option and moves the choice off the typed answer (its text
/// stays); a multi-select one toggles it.
pub fn pick_option(drafts: &mut Drafts, question: &AgentQuestion, label: &str) {
    let mut draft = draft_of(drafts, &question.id);
    if !question.multi_select {
        draft.picked = vec![label.to_string()];
        draft.other = Some(false);
    } else if let Some(at) = draft.picked.iter().position(|item| item == label) {
        draft.picked.remove(at);
    } else {
        draft.picked.push(label.to_string());
    }
    drafts.insert(question.id.clone(), draft);
}

/// `typeAnswer`: typing chooses the answer; on a single-choice question it replaces the picked option.
pub fn type_answer(drafts: &mut Drafts, question: &AgentQuestion, typed: &str) {
    let mut draft = draft_of(drafts, &question.id);
    let wrote = !typed.trim().is_empty();
    if !question.multi_select && wrote {
        draft.picked.clear();
    }
    draft.other = Some(wrote || draft.other.unwrap_or(false));
    draft.typed = typed.to_string();
    drafts.insert(question.id.clone(), draft);
}

/// `chooseOther`: the only choice on a single-choice question, toggled on a multi-select one.
pub fn choose_other(drafts: &mut Drafts, question: &AgentQuestion) {
    let mut draft = draft_of(drafts, &question.id);
    if !question.multi_select {
        draft.picked.clear();
        draft.other = Some(true);
    } else {
        draft.other = Some(!other_chosen(&draft));
    }
    drafts.insert(question.id.clone(), draft);
}

/// `otherChosen`.
pub fn other_chosen(draft: &Draft) -> bool {
    draft.other.unwrap_or(!draft.typed.trim().is_empty())
}

/// `draftAnswers`: picks in the agent's option order, then the typed answer; `None` while a question has none.
pub fn draft_answers(questions: &[AgentQuestion], drafts: &Drafts) -> Option<Vec<(String, Vec<String>)>> {
    let mut answers = Vec::new();
    for question in questions {
        let draft = draft_of(drafts, &question.id);
        let mut values: Vec<String> =
            question.options.iter().map(|option| option.label.clone()).filter(|label| draft.picked.contains(label)).collect();
        if question.allow_other && other_chosen(&draft) && !draft.typed.trim().is_empty() {
            values.push(draft.typed.trim().to_string());
        }
        if values.is_empty() {
            return None;
        }
        answers.push((question.id.clone(), values));
    }
    Some(answers)
}

/// The answers as the user's message keeps them (`AnsweredQuestion`): a typed answer to a secret question is masked.
pub fn answered_questions(questions: &[AgentQuestion], answers: &[(String, Vec<String>)]) -> Vec<AnsweredQuestion> {
    questions
        .iter()
        .map(|question| {
            let values = answers.iter().find(|(id, _)| *id == question.id).map(|(_, values)| values.as_slice()).unwrap_or_default();
            let shown = values
                .iter()
                .map(|value| {
                    let typed = question.secret && !question.options.iter().any(|option| option.label == *value);
                    if typed { "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}".into() } else { value.clone().into() }
                })
                .collect();
            AnsweredQuestion { header: question.header.clone().into(), question: question.question.clone().into(), answers: shown }
        })
        .collect()
}

/// `sendsOnPick`: a card with one single-choice question sends as soon as an option is picked.
pub fn sends_on_pick(questions: &[AgentQuestion]) -> bool {
    matches!(questions, [only] if !only.multi_select)
}

/// `advancesOnPick`: on a card with several questions a pick on a single-choice one moves on, except at the last.
pub fn advances_on_pick(questions: &[AgentQuestion], active: usize) -> bool {
    questions.len() > 1
        && questions.get(active).is_some_and(|question| !question.multi_select)
        && primary_action(questions, active) == Primary::Next
}

/// `questionAnswered`.
pub fn question_answered(question: &AgentQuestion, drafts: &Drafts) -> bool {
    draft_answers(std::slice::from_ref(question), drafts).is_some()
}

/// `tabLabel`: the header, or the position.
pub fn tab_label(question: &AgentQuestion, index: usize) -> String {
    let header = question.header.trim();
    if header.is_empty() { format!("Question {}", index + 1) } else { header.to_string() }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Primary {
    Next,
    Send,
}

/// `primaryAction`: Next on every question but the last.
pub fn primary_action(questions: &[AgentQuestion], active: usize) -> Primary {
    if active + 1 < questions.len() { Primary::Next } else { Primary::Send }
}

/// `primaryEnabled`: Next needs the active question answered; Send needs every question answered.
pub fn primary_enabled(questions: &[AgentQuestion], drafts: &Drafts, active: usize) -> bool {
    let Some(question) = questions.get(active) else { return false };
    match primary_action(questions, active) {
        Primary::Next => question_answered(question, drafts),
        Primary::Send => draft_answers(questions, drafts).is_some(),
    }
}

/// `nextTab`: one on, staying on the last.
pub fn next_tab(count: usize, active: usize) -> usize {
    (active + 1).min(count.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::activity::subchat_states::QuestionOption;

    fn question(id: &str, multi: bool, other: bool) -> AgentQuestion {
        AgentQuestion {
            id: id.into(),
            header: String::new(),
            question: format!("Question {id}?"),
            options: ["A", "B", "C"].map(|label| QuestionOption { label: label.into(), description: None }).to_vec(),
            multi_select: multi,
            allow_other: other,
            secret: false,
        }
    }

    #[test]
    fn single_choice_keeps_one_pick_and_typing_replaces_it() {
        let q = question("q", false, true);
        let mut drafts = Drafts::new();
        pick_option(&mut drafts, &q, "A");
        pick_option(&mut drafts, &q, "B");
        assert_eq!(draft_of(&drafts, "q").picked, ["B"]);
        type_answer(&mut drafts, &q, "my own");
        assert!(draft_of(&drafts, "q").picked.is_empty());
        assert_eq!(draft_answers(std::slice::from_ref(&q), &drafts).unwrap()[0].1, ["my own"]);
        pick_option(&mut drafts, &q, "C");
        // The text stays but the choice moved off it.
        assert_eq!(draft_of(&drafts, "q").typed, "my own");
        assert_eq!(draft_answers(&[q], &drafts).unwrap()[0].1, ["C"]);
    }

    #[test]
    fn multi_select_toggles_and_answers_in_option_order() {
        let q = question("q", true, true);
        let mut drafts = Drafts::new();
        pick_option(&mut drafts, &q, "C");
        pick_option(&mut drafts, &q, "A");
        type_answer(&mut drafts, &q, "extra");
        assert_eq!(draft_answers(std::slice::from_ref(&q), &drafts).unwrap()[0].1, ["A", "C", "extra"]);
        pick_option(&mut drafts, &q, "C");
        choose_other(&mut drafts, &q);
        assert_eq!(draft_answers(&[q], &drafts).unwrap()[0].1, ["A"]);
    }

    #[test]
    fn send_needs_every_question_and_next_only_the_active_one() {
        let qs = [question("a", false, false), question("b", false, false)];
        let mut drafts = Drafts::new();
        assert!(!primary_enabled(&qs, &drafts, 0));
        pick_option(&mut drafts, &qs[0], "A");
        assert!(primary_enabled(&qs, &drafts, 0));
        assert!(!primary_enabled(&qs, &drafts, 1));
        assert_eq!(primary_action(&qs, 0), Primary::Next);
        assert_eq!(primary_action(&qs, 1), Primary::Send);
        assert!(advances_on_pick(&qs, 0) && !advances_on_pick(&qs, 1));
        assert!(!sends_on_pick(&qs) && sends_on_pick(&qs[..1]));
        assert_eq!((next_tab(2, 0), next_tab(2, 1)), (1, 1));
    }

    #[test]
    fn secret_typed_answers_are_masked_in_the_record() {
        let mut q = question("s", false, true);
        q.secret = true;
        let mut drafts = Drafts::new();
        type_answer(&mut drafts, &q, "hunter2");
        let answers = draft_answers(std::slice::from_ref(&q), &drafts).unwrap();
        let record = answered_questions(&[q], &answers);
        assert_eq!(record[0].answers[0].as_ref(), "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}");
    }

    #[test]
    fn tab_labels_fall_back_to_position() {
        let mut q = question("q", false, false);
        assert_eq!(tab_label(&q, 1), "Question 2");
        q.header = " Library ".into();
        assert_eq!(tab_label(&q, 1), "Library");
    }
}
