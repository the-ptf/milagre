//! Subchats (`packages/shared/src/subchats.ts`): a Chat a Delegation inside one Project reached keeps the
//! requester's session id as `parent`. The Chat lists nest it under its topmost ancestor that is still listed.
//! It opens alone, as any Chat does, with a bookmark back to the Chat above it ([`chat_bookmark`]).
//!
//! Chat keys are `<project>#<id>`.

use std::collections::{BTreeMap, HashMap, HashSet};

/// The sidebars indent a family this deep at most: anything further sits level with its parent.
pub const MAX_SUBCHAT_DEPTH: usize = 2;

/// `key.slice(0, key.lastIndexOf("#"))`. A key with no `#` loses its last character, as `slice(0, -1)` does.
fn scope_of(key: &str) -> &str {
    match key.rfind('#') {
        Some(hash) => &key[..hash],
        None => key.char_indices().next_back().map_or("", |(last, _)| &key[..last]),
    }
}

/// `<project>#<parent>` for a session that has one: subchats always share their parent's Project. `None` for a
/// top-level Chat, or a key with no `#`.
pub fn parent_key(key: &str, parent: Option<u64>) -> Option<String> {
    let parent = parent?;
    let hash = key.rfind('#')?;
    Some(format!("{}#{parent}", &key[..hash]))
}

/// The topmost ancestor of `key` that `listed` holds, or `None` when no ancestor is listed (an archived or hidden
/// parent leaves its subchats top-level). A broken chain that loops stops where it repeats.
pub fn subchat_root(key: &str, parent_of: &impl Fn(&str) -> Option<String>, listed: &impl Fn(&str) -> bool) -> Option<String> {
    let mut root = None;
    let mut seen = HashSet::from([key.to_owned()]);
    let mut at = parent_of(key);
    while let Some(current) = at {
        if !seen.insert(current.clone()) {
            break;
        }
        if listed(&current) {
            root = Some(current.clone());
        }
        at = parent_of(&current);
    }
    root
}

/// A row with the listed subchats under it.
#[derive(Clone, Debug, PartialEq)]
pub struct SubchatGroup<T> {
    pub row: T,
    /// The listed subchats under `row`, each right after the Chat above it; empty for a Chat without any.
    pub children: Vec<T>,
    /// How deep each of `children` sits, by index: 1 directly under `row`, [`MAX_SUBCHAT_DEPTH`] at most.
    pub depths: Vec<usize>,
}

/// `children` of `root` in tree order, each after the listed Chat above it; siblings keep their order.
fn tree_order<T: Clone>(
    root: &str,
    children: &[T],
    key_of: &impl Fn(&T) -> String,
    parent_of: &impl Fn(&str) -> Option<String>,
    listed: &impl Fn(&str) -> bool,
) -> (Vec<T>, Vec<usize>) {
    let mut under: HashMap<String, Vec<&T>> = HashMap::new();
    for child in children {
        let mut seen = HashSet::from([key_of(child)]);
        let mut above = parent_of(&key_of(child));
        while let Some(current) = above.clone() {
            if listed(&current) || seen.contains(&current) {
                break;
            }
            seen.insert(current.clone());
            above = parent_of(&current);
        }
        let parent = match above {
            Some(above) if !seen.contains(&above) => above,
            _ => root.to_owned(),
        };
        under.entry(parent).or_default().push(child);
    }
    let mut ordered = Vec::new();
    let mut depths = Vec::new();
    let mut placed: HashSet<String> = HashSet::new();
    fn walk<T: Clone>(
        key: &str,
        depth: usize,
        under: &HashMap<String, Vec<&T>>,
        key_of: &impl Fn(&T) -> String,
        placed: &mut HashSet<String>,
        ordered: &mut Vec<T>,
        depths: &mut Vec<usize>,
    ) {
        for child in under.get(key).map(Vec::as_slice).unwrap_or_default() {
            let at = key_of(child);
            if !placed.insert(at.clone()) {
                continue;
            }
            ordered.push((*child).clone());
            depths.push(depth.min(MAX_SUBCHAT_DEPTH));
            walk(&at, depth + 1, under, key_of, placed, ordered, depths);
        }
    }
    walk(root, 1, &under, key_of, &mut placed, &mut ordered, &mut depths);
    // A broken chain that loops never reaches `root`: its Chats stay in the family, directly under it.
    for child in children {
        if placed.contains(&key_of(child)) {
            continue;
        }
        ordered.push(child.clone());
        depths.push(1);
    }
    (ordered, depths)
}

/// `rows` with each subchat moved under its topmost listed ancestor. A family sits where its first member was, so
/// a subchat's activity brings its parent up with it; a subchat sits right after the Chat above it, siblings in
/// their order.
pub fn nest_subchats<T: Clone>(
    rows: &[T],
    key_of: impl Fn(&T) -> String,
    parent_of: impl Fn(&str) -> Option<String>,
) -> Vec<SubchatGroup<T>> {
    let listed: HashSet<String> = rows.iter().map(&key_of).collect();
    // `new Map(rows.map(...))`: of two rows with one key, the later is the one a group shows.
    let by_key: HashMap<String, &T> = rows.iter().map(|row| (key_of(row), row)).collect();
    let is_listed = |at: &str| listed.contains(at);
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut order: Vec<SubchatGroup<T>> = Vec::new();
    let mut group_of = |key: &str, order: &mut Vec<SubchatGroup<T>>| -> usize {
        *index.entry(key.to_owned()).or_insert_with(|| {
            order.push(SubchatGroup { row: (*by_key[key]).clone(), children: Vec::new(), depths: Vec::new() });
            order.len() - 1
        })
    };
    for row in rows {
        let key = key_of(row);
        match subchat_root(&key, &parent_of, &is_listed) {
            None => {
                group_of(&key, &mut order);
            }
            Some(root) => {
                let at = group_of(&root, &mut order);
                order[at].children.push(row.clone());
            }
        }
    }
    for group in &mut order {
        if group.children.len() < 2 {
            group.depths = group.children.iter().map(|_| 1).collect();
            continue;
        }
        let (children, depths) = tree_order(&key_of(&group.row), &group.children, &key_of, &parent_of, &is_listed);
        group.children = children;
        group.depths = depths;
    }
    order
}

/// What the family rules read from a Chat (`FamilySession`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FamilySession {
    pub id: u64,
    pub parent: Option<u64>,
    pub archived: bool,
    /// When it was marked Done, in ms; `None` (or 0) when it is not.
    pub done_at: Option<i64>,
}

/// A Project's Chats by id, ascending as a JavaScript object lists its integer keys.
pub type FamilySessions = BTreeMap<u64, FamilySession>;

/// The session a Chat key names within `scope`: the text after `<scope>#`, which must be a canonical id.
fn session_of<'a>(sessions: &'a FamilySessions, scope: &str, at: &str) -> Option<&'a FamilySession> {
    let id = at.get(scope.len() + 1..)?;
    let number: u64 = id.parse().ok()?;
    // A key such as "01" or "+1" names no session of an object keyed by "1".
    if number.to_string() != id {
        return None;
    }
    sessions.get(&number)
}

/// The family the Chat `key` belongs to in its Project's state: its topmost ancestor still listed (not archived),
/// and that ancestor's listed subchats, oldest first. Done ones are left out, except `key` itself, which is always
/// in its own family. `None` for a Chat with no family.
pub fn chat_family(sessions: Option<&FamilySessions>, key: &str) -> Option<(String, Vec<String>)> {
    let sessions = sessions?;
    let scope = scope_of(key);
    let listed = |at: &str| session_of(sessions, scope, at).is_some_and(|session| !session.archived);
    let parent_of = |at: &str| parent_key(at, session_of(sessions, scope, at).and_then(|session| session.parent));
    let root = subchat_root(key, &parent_of, &listed).unwrap_or_else(|| key.to_owned());
    let children: Vec<String> = sessions
        .values()
        .filter(|session| !session.archived && session.parent.is_some())
        .map(|session| (session, format!("{scope}#{}", session.id)))
        .filter(|(session, at)| {
            (session.done_at.is_none_or(|done| done == 0) || at == key)
                && *at != root
                && subchat_root(at, &parent_of, &listed).as_deref() == Some(root.as_str())
        })
        .map(|(_, at)| at)
        .collect();
    if !children.is_empty() || root != key { Some((root, children)) } else { None }
}

/// What the bookmark over an open Chat points at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatBookmark {
    /// The nearest ancestor still listed.
    pub parent: String,
    /// The listed ones above that, the top Chat first, which collapse into the bookmark's "…".
    pub above: Vec<String>,
}

/// What the bookmark over the open Chat `key` points at: its nearest ancestor still listed, and the listed ones
/// above that (the top Chat first). An archived direct parent is skipped, so the bookmark and the sidebar agree.
/// `None` for a top-level Chat, or one with no listed ancestor left.
pub fn chat_bookmark(sessions: Option<&FamilySessions>, key: &str) -> Option<ChatBookmark> {
    let sessions = sessions?;
    let scope = scope_of(key);
    let session_of = |at: &str| session_of(sessions, scope, at);
    let mut chain: Vec<String> = Vec::new();
    let mut seen = HashSet::from([key.to_owned()]);
    let mut at = parent_key(key, session_of(key).and_then(|session| session.parent));
    while let Some(current) = at {
        if !seen.insert(current.clone()) {
            break;
        }
        if session_of(&current).is_some_and(|session| !session.archived) {
            chain.push(current.clone());
        }
        at = parent_key(&current, session_of(&current).and_then(|session| session.parent));
    }
    let mut chain = chain.into_iter();
    let parent = chain.next()?;
    let mut above: Vec<String> = chain.collect();
    above.reverse();
    Some(ChatBookmark { parent, above })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parents() -> HashMap<&'static str, &'static str> {
        HashMap::from([("p#2", "p#1"), ("p#3", "p#1"), ("p#4", "p#3"), ("p#9", "p#8")])
    }

    fn parent_of(key: &str) -> Option<String> {
        parents().get(key).map(|parent| (*parent).to_owned())
    }

    fn key(row: &&str) -> String {
        (*row).to_owned()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn a_sessions_parent_key_shares_its_project() {
        assert_eq!(parent_key("/a/b#12", Some(7)).as_deref(), Some("/a/b#7"));
        assert_eq!(parent_key("/a/b#12", None), None);
        assert_eq!(parent_key("no-hash", Some(7)), None);
        assert_eq!(parent_key("/my#project#12", Some(7)).as_deref(), Some("/my#project#7"));
    }

    #[test]
    fn a_subchat_nests_under_its_topmost_listed_ancestor() {
        assert_eq!(subchat_root("p#4", &parent_of, &|_| true).as_deref(), Some("p#1"));
        assert_eq!(subchat_root("p#4", &parent_of, &|at| at == "p#3").as_deref(), Some("p#3"));
        assert_eq!(subchat_root("p#9", &parent_of, &|_| false), None);
        assert_eq!(subchat_root("p#1", &parent_of, &|_| true), None);
    }

    #[test]
    fn a_looping_chain_stops_where_it_repeats() {
        let looped = |at: &str| match at {
            "p#1" => Some("p#2".to_owned()),
            "p#2" => Some("p#1".to_owned()),
            _ => None,
        };
        assert_eq!(subchat_root("p#1", &looped, &|_| true).as_deref(), Some("p#2"));
    }

    #[test]
    fn a_family_sits_where_its_first_member_was_each_child_after_the_chat_above_it() {
        let nested = nest_subchats(&["p#5", "p#3", "p#1", "p#2", "p#4", "p#9"], key, parent_of);
        let shape: Vec<(&str, Vec<&str>)> = nested.iter().map(|group| (group.row, group.children.clone())).collect();
        assert_eq!(shape, [("p#5", vec![]), ("p#1", vec!["p#3", "p#4", "p#2"]), ("p#9", vec![])]);
        assert_eq!(nested[1].depths, [1, 2, 1]);
    }

    #[test]
    fn a_subchat_sits_right_after_the_chat_above_it_one_level_deeper_up_to_the_cap() {
        let chain = HashMap::from([("p#2", "p#1"), ("p#3", "p#1"), ("p#4", "p#2"), ("p#5", "p#4")]);
        let groups = nest_subchats(&["p#1", "p#2", "p#3", "p#4", "p#5"], key, |at| chain.get(at).map(|parent| (*parent).to_owned()));
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].children, ["p#2", "p#4", "p#5", "p#3"]);
        assert_eq!(groups[0].depths, [1, 2, MAX_SUBCHAT_DEPTH, 1]);
    }

    #[test]
    fn a_looping_family_still_groups_every_chat_once() {
        // 1 and 2 name each other as parent, 3 hangs off 2: each of the two finds the other as its topmost
        // ancestor, so both lead a group, and the second one's family is ordered as a tree.
        let looped = HashMap::from([("p#1", "p#2"), ("p#2", "p#1"), ("p#3", "p#2")]);
        let groups = nest_subchats(&["p#1", "p#2", "p#3"], key, |at| looped.get(at).map(|parent| (*parent).to_owned()));
        let shape: Vec<(&str, Vec<&str>)> = groups.iter().map(|group| (group.row, group.children.clone())).collect();
        assert_eq!(shape, [("p#2", vec!["p#1"]), ("p#1", vec!["p#2", "p#3"])]);
        assert_eq!(groups[0].depths, [1]);
        assert_eq!(groups[1].depths, [1, 2]);
    }

    #[test]
    fn a_subchat_with_an_unlisted_parent_nests_under_the_listed_grandparent() {
        let chain = HashMap::from([("p#2", "p#7"), ("p#7", "p#1"), ("p#3", "p#2")]);
        let groups = nest_subchats(&["p#1", "p#2", "p#3"], key, |at| chain.get(at).map(|parent| (*parent).to_owned()));
        assert_eq!(groups[0].children, ["p#2", "p#3"]);
        assert_eq!(groups[0].depths, [1, 2]);
    }

    fn sessions() -> FamilySessions {
        let session = |id, parent, archived, done_at| FamilySession { id, parent, archived, done_at };
        FamilySessions::from([
            (1, session(1, None, false, None)),
            (2, session(2, Some(1), false, None)),
            (3, session(3, Some(2), false, None)),
            (4, session(4, Some(1), false, Some(10))),
            (5, session(5, Some(6), false, None)),
            (6, session(6, Some(1), true, None)),
        ])
    }

    #[test]
    fn a_family_leaves_done_subchats_out_but_never_the_open_one() {
        let sessions = sessions();
        assert_eq!(chat_family(Some(&sessions), "/a#1"), Some(("/a#1".to_owned(), strings(&["/a#2", "/a#3", "/a#5"]))));
        assert_eq!(chat_family(Some(&sessions), "/a#4"), Some(("/a#1".to_owned(), strings(&["/a#2", "/a#3", "/a#4", "/a#5"]))));
        assert_eq!(chat_family(None, "/a#1"), None);
        let alone = FamilySessions::from([(1, FamilySession { id: 1, ..FamilySession::default() })]);
        assert_eq!(chat_family(Some(&alone), "/a#1"), None);
    }

    #[test]
    fn the_bookmark_points_at_the_nearest_listed_ancestor_with_the_rest_above_it() {
        let sessions = sessions();
        let bookmark = |key| chat_bookmark(Some(&sessions), key);
        assert_eq!(bookmark("/a#2"), Some(ChatBookmark { parent: "/a#1".into(), above: vec![] }));
        assert_eq!(bookmark("/a#3"), Some(ChatBookmark { parent: "/a#2".into(), above: strings(&["/a#1"]) }));
        assert_eq!(bookmark("/a#5"), Some(ChatBookmark { parent: "/a#1".into(), above: vec![] }));
        assert_eq!(bookmark("/a#1"), None);
        let archived = FamilySessions::from([
            (1, FamilySession { id: 1, archived: true, ..FamilySession::default() }),
            (2, FamilySession { id: 2, parent: Some(1), ..FamilySession::default() }),
        ]);
        assert_eq!(chat_bookmark(Some(&archived), "/a#2"), None);
        let looped = FamilySessions::from([
            (1, FamilySession { id: 1, parent: Some(2), ..FamilySession::default() }),
            (2, FamilySession { id: 2, parent: Some(1), ..FamilySession::default() }),
        ]);
        assert_eq!(chat_bookmark(Some(&looped), "/a#1").map(|bookmark| bookmark.parent), Some("/a#2".to_owned()));
        assert_eq!(chat_bookmark(None, "/a#2"), None);
    }

    #[test]
    fn a_key_with_no_hash_loses_its_last_character_as_slice_does() {
        assert_eq!(scope_of("/a#3"), "/a");
        assert_eq!(scope_of("abc"), "ab");
        assert_eq!(scope_of(""), "");
    }
}
