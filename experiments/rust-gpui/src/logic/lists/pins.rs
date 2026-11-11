//! Device-local pins (`packages/shared/src/chat-pins.ts`). Pins belong to the device that made them, like the Chat
//! order and the filters: each Mac and each phone keeps its own, and pinning a Chat on one never pins it on
//! another. Chats still carry the `pinned` and `pin_order` every device used to share; a scope this device hasn't
//! pinned in yet shows those, so nobody loses the pins they had, and its first pin or unpin copies them here and
//! leaves them behind for good.

use std::collections::BTreeMap;

use super::chats::RoutineHidden;
use super::raw::Raw;

/// One scope's pins on this device: session id (as the decimal string a saved object keys it by) to pin order.
pub type ScopePins = BTreeMap<String, f64>;
/// Every scope's pins on this device, by scope key (a Project path, `<computer>|<path>`, a Link's key).
pub type DevicePins = BTreeMap<String, ScopePins>;

/// A Chat as the pin rules see it (`Pinnable`): its id and the pin it carries.
pub trait Pinnable: Clone {
    fn id(&self) -> u64;
    fn pinned(&self) -> bool;
    fn pin_order(&self) -> Option<f64>;
    /// The Chat with `pinned` and `pin_order` set (`{ ...session, pinned, pin_order }`).
    fn with_pin_state(&self, pinned: bool, pin_order: Option<f64>) -> Self;
}

/// Whether pinning a Chat should tell its host the user took it over (`SessionPatch.kept`): only a Run Chat its
/// host may still hide, as the host's `keepRunChat` decides. Any other pin stays on this device alone.
pub fn keeps_on_pin(routine: Option<RoutineHidden>) -> bool {
    routine.is_some_and(|routine| routine.hidden != Some(false))
}

/// The pins `scope` shows here: this device's own, or the shared ones its Chats carry until this device changes one.
pub fn scope_pins<'a, T: Pinnable + 'a>(saved: &DevicePins, scope: &str, sessions: impl IntoIterator<Item = &'a T>) -> ScopePins {
    if let Some(own) = saved.get(scope) {
        return own.clone();
    }
    let mut shared = ScopePins::new();
    for session in sessions {
        if session.pinned() {
            shared.insert(session.id().to_string(), session.pin_order().unwrap_or(0.0));
        }
    }
    shared
}

/// `session` with this device's pin; `None` when nothing changes, so a caller keeps the Chat it has.
pub fn with_pin<T: Pinnable>(session: &T, pins: &ScopePins) -> Option<T> {
    let order = pins.get(&session.id().to_string()).copied();
    let pinned = order.is_some();
    if session.pinned() == pinned && (!pinned || Some(session.pin_order().unwrap_or(0.0)) == order) {
        return None;
    }
    Some(session.with_pin_state(pinned, order))
}

/// A scope's `sessions` (by id) with this device's pins in place of the ones they carry; `None` when none differ.
pub fn sessions_with_pins<T: Pinnable>(sessions: &BTreeMap<u64, T>, scope: &str, saved: &DevicePins) -> Option<BTreeMap<u64, T>> {
    let pins = scope_pins(saved, scope, sessions.values());
    let mut next: Option<BTreeMap<u64, T>> = None;
    for (id, session) in sessions {
        if let Some(pinned) = with_pin(session, &pins) {
            next.get_or_insert_with(|| sessions.clone()).insert(*id, pinned);
        }
    }
    next
}

/// `saved` with Chat `id` of `scope` pinned at `order`, or unpinned for `None` (or a non-finite order). The scope's
/// pins become this device's own: the shared ones it showed are copied first, and pins of Chats no longer in
/// `sessions` (deleted ones) drop out.
pub fn set_pin<T: Pinnable>(saved: &DevicePins, scope: &str, sessions: &[T], id: u64, order: Option<f64>) -> DevicePins {
    let live: Vec<String> = sessions.iter().map(|session| session.id().to_string()).collect();
    let mut next = ScopePins::new();
    for (key, value) in scope_pins(saved, scope, sessions.iter()) {
        if live.contains(&key) {
            next.insert(key, value);
        }
    }
    match order {
        Some(order) if order.is_finite() => next.insert(id.to_string(), order),
        _ => next.remove(&id.to_string()),
    };
    let mut all = saved.clone();
    all.insert(scope.to_owned(), next);
    all
}

/// Saved pins read back: anything that isn't scope to id to a finite order is dropped.
pub fn parse_device_pins(raw: &Raw) -> DevicePins {
    let Raw::Object(scopes) = raw else { return DevicePins::new() };
    let mut result = DevicePins::new();
    for (scope, pins) in scopes {
        let Raw::Object(entries) = pins else { continue };
        let mut kept = ScopePins::new();
        for (id, order) in entries {
            if let Raw::Number(order) = order
                && order.is_finite()
                && !id.is_empty()
                && id.bytes().all(|byte| byte.is_ascii_digit())
            {
                kept.insert(id.clone(), *order);
            }
        }
        result.insert(scope.clone(), kept);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Session {
        id: u64,
        pinned: bool,
        pin_order: Option<f64>,
    }

    impl Pinnable for Session {
        fn id(&self) -> u64 {
            self.id
        }
        fn pinned(&self) -> bool {
            self.pinned
        }
        fn pin_order(&self) -> Option<f64> {
            self.pin_order
        }
        fn with_pin_state(&self, pinned: bool, pin_order: Option<f64>) -> Self {
            Session { pinned, pin_order, ..self.clone() }
        }
    }

    fn session(id: u64, pinned: bool, pin_order: Option<f64>) -> Session {
        Session { id, pinned, pin_order }
    }

    fn sessions() -> Vec<Session> {
        vec![session(1, true, Some(2.0)), session(2, false, None), session(3, true, None)]
    }

    fn pins(entries: &[(&str, f64)]) -> ScopePins {
        entries.iter().map(|(id, order)| ((*id).to_owned(), *order)).collect()
    }

    fn device(scope: &str, scope_pins: ScopePins) -> DevicePins {
        DevicePins::from([(scope.to_owned(), scope_pins)])
    }

    #[test]
    fn a_scope_this_device_never_pinned_in_shows_the_pins_its_chats_carry() {
        assert_eq!(scope_pins(&DevicePins::new(), "/p", &sessions()), pins(&[("1", 2.0), ("3", 0.0)]));
        assert_eq!(scope_pins(&DevicePins::new(), "/p", &[session(2, false, None)]), pins(&[]));
    }

    #[test]
    fn this_devices_own_pins_replace_the_shared_ones_even_when_it_has_none_left() {
        assert_eq!(scope_pins(&device("/p", pins(&[("2", 0.0)])), "/p", &sessions()), pins(&[("2", 0.0)]));
        assert_eq!(scope_pins(&device("/p", pins(&[])), "/p", &sessions()), pins(&[]));
        assert_eq!(scope_pins(&device("/q", pins(&[])), "/p", &sessions()), pins(&[("1", 2.0), ("3", 0.0)]));
    }

    #[test]
    fn the_first_pin_copies_the_shared_pins_then_only_this_devices_changes_count() {
        let once = set_pin(&DevicePins::new(), "/p", &sessions(), 2, Some(5.0));
        assert_eq!(once, device("/p", pins(&[("1", 2.0), ("3", 0.0), ("2", 5.0)])));
        let twice = set_pin(&once, "/p", &sessions(), 1, None);
        assert_eq!(twice, device("/p", pins(&[("3", 0.0), ("2", 5.0)])));
        // The Chats still say 1 is pinned; this device no longer does.
        assert_eq!(scope_pins(&twice, "/p", &sessions()), pins(&[("3", 0.0), ("2", 5.0)]));
        // A pin at a non-finite order is an unpin.
        assert_eq!(set_pin(&once, "/p", &sessions(), 2, Some(f64::NAN)), device("/p", pins(&[("1", 2.0), ("3", 0.0)])));
    }

    #[test]
    fn pins_of_chats_that_are_gone_drop_out_on_the_next_change() {
        let saved = device("/p", pins(&[("9", 0.0), ("1", 1.0)]));
        assert_eq!(set_pin(&saved, "/p", &sessions(), 2, Some(3.0)), device("/p", pins(&[("1", 1.0), ("2", 3.0)])));
    }

    #[test]
    fn a_session_takes_this_devices_pin_and_reports_when_nothing_changes() {
        let pinned = session(1, true, Some(2.0));
        assert_eq!(with_pin(&pinned, &pins(&[("1", 2.0)])), None);
        assert_eq!(with_pin(&pinned, &pins(&[])), Some(session(1, false, None)));
        assert_eq!(with_pin(&session(2, false, None), &pins(&[("2", 4.0)])), Some(session(2, true, Some(4.0))));
        assert_eq!(with_pin(&session(2, false, None), &pins(&[("1", 0.0)])), None);
        // A pinned Chat without an order counts as order 0.
        assert_eq!(with_pin(&session(3, true, None), &pins(&[("3", 0.0)])), None);
        assert_eq!(with_pin(&pinned, &pins(&[("1", 9.0)])), Some(session(1, true, Some(9.0))));
    }

    #[test]
    fn saved_pins_keep_only_numeric_ids_with_finite_orders() {
        let object = |fields: Vec<(&str, Raw)>| Raw::Object(fields.into_iter().map(|(key, value)| (key.to_owned(), value)).collect());
        let raw = object(vec![
            (
                "/p",
                object(vec![
                    ("1", Raw::Number(2.0)),
                    ("x", Raw::Number(1.0)),
                    ("3", Raw::Str("a".into())),
                    ("4", Raw::Null),
                    ("5", Raw::Number(f64::INFINITY)),
                ]),
            ),
            ("/q", Raw::Array(vec![])),
            ("/r", object(vec![])),
        ]);
        let expected = DevicePins::from([("/p".to_owned(), pins(&[("1", 2.0)])), ("/r".to_owned(), pins(&[]))]);
        assert_eq!(parse_device_pins(&raw), expected);
        assert_eq!(parse_device_pins(&Raw::Null), DevicePins::new());
        assert_eq!(parse_device_pins(&Raw::Array(vec![Raw::Number(1.0)])), DevicePins::new());
    }

    #[test]
    fn a_scopes_sessions_take_this_devices_pins_and_none_differ_reports_none() {
        let by_id = BTreeMap::from([(1, session(1, true, Some(2.0))), (2, session(2, false, None))]);
        assert_eq!(sessions_with_pins(&by_id, "/p", &DevicePins::new()), None);
        let mine = sessions_with_pins(&by_id, "/p", &device("/p", pins(&[("2", 0.0)]))).unwrap();
        assert_eq!(mine, BTreeMap::from([(1, session(1, false, None)), (2, session(2, true, Some(0.0)))]));
        assert!(by_id[&1].pinned, "the given sessions are untouched");
    }

    #[test]
    fn only_a_run_chat_its_host_may_still_hide_is_kept_on_a_pin() {
        assert!(keeps_on_pin(Some(RoutineHidden { hidden: Some(true) })));
        assert!(keeps_on_pin(Some(RoutineHidden { hidden: None })), "saved before Run Chats could be hidden");
        assert!(!keeps_on_pin(Some(RoutineHidden { hidden: Some(false) })));
        assert!(!keeps_on_pin(None));
    }
}
