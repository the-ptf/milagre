//! A list's order for this session (`packages/shared/src/stable-order.mjs`): rows already shown keep their place.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

/// A Projects list's order for this session: keys already shown keep their place, and a key seen for the first
/// time (a project just added) goes on top. Opening a project reorders the host's recent list; the list doesn't
/// follow.
pub fn stable_order<K: Clone + Eq + Hash>(previous: &[K], next: &[K]) -> Vec<K> {
    let present: HashSet<&K> = next.iter().collect();
    let kept: Vec<K> = previous.iter().filter(|key| present.contains(key)).cloned().collect();
    let known: HashSet<&K> = kept.iter().collect();
    let mut ordered: Vec<K> = next.iter().filter(|key| !known.contains(key)).cloned().collect();
    ordered.extend(kept.iter().cloned());
    ordered
}

/// `next`'s items in the order `previous` showed them, by [`stable_order`] on `key_of`. When two of `next` share a
/// key the later one stands in the first one's place, as in a JavaScript `Map`.
pub fn keep_order<T: Clone, K: Clone + Eq + Hash>(previous: &[T], next: &[T], key_of: impl Fn(&T) -> K) -> Vec<T> {
    let mut keys: Vec<K> = Vec::new();
    let mut by_key: HashMap<K, T> = HashMap::new();
    for item in next {
        let key = key_of(item);
        if by_key.insert(key.clone(), item.clone()).is_none() {
            keys.push(key);
        }
    }
    let previous_keys: Vec<K> = previous.iter().map(&key_of).collect();
    stable_order(&previous_keys, &keys).into_iter().filter_map(|key| by_key.get(&key).cloned()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_order_keeps_shown_keys_in_place_drops_removed_ones_and_puts_new_ones_on_top() {
        assert_eq!(stable_order::<String>(&[], &strings(&["a", "b", "c"])), strings(&["a", "b", "c"]));
        // A known key moving to the front of the recent list keeps its old place.
        assert_eq!(stable_order(&strings(&["a", "b", "c"]), &strings(&["c", "a", "b"])), strings(&["a", "b", "c"]));
        // A key that left the list drops out.
        assert_eq!(stable_order(&strings(&["a", "b", "c"]), &strings(&["c", "a"])), strings(&["a", "c"]));
        // A key seen for the first time goes on top.
        assert_eq!(stable_order(&strings(&["a", "b"]), &strings(&["b", "d", "a"])), strings(&["d", "a", "b"]));
    }

    #[test]
    fn keep_order_keeps_rows_in_place_when_the_hosts_recent_list_reorders() {
        let shown = [("/a", ""), ("/b", ""), ("/c", "")];
        let reloaded = [("/c", "C"), ("/a", ""), ("/b", "")];
        assert_eq!(keep_order(&shown, &reloaded, |item| item.0), [("/a", ""), ("/b", ""), ("/c", "C")]);
    }

    #[test]
    fn keep_order_puts_new_rows_on_top_and_drops_removed_ones() {
        let shown = [("/a", 0), ("/b", 0)];
        assert_eq!(keep_order(&shown, &[("/b", 0), ("/d", 0)], |item| item.0), [("/d", 0), ("/b", 0)]);
    }

    #[test]
    fn keep_order_lets_a_later_duplicate_replace_the_first() {
        assert_eq!(keep_order(&[], &[("/a", 1), ("/b", 2), ("/a", 3)], |item| item.0), [("/a", 3), ("/b", 2)]);
    }
}
