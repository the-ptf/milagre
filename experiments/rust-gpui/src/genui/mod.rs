//! Generative UI in the transcript (WP-38, surface T-28): an `openui` fence drawn from native components.
//! `apps/desktop/app/src/components/genui/*`, `packages/shared/src/{genui,genui-renderer}.ts(x)`.
//!
//! Decision: `@openuidev/lang-core` is a 150 KB JavaScript package (a parser, a store, a query manager, prompt
//! generation), but a reply can only reach the part `genui.ts` wires up: the lexer, the statement splitter, the
//! Pratt expression parser, `autoClose` for a block still streaming, and the walk from `root` through references.
//! That part is ported in [`lang`] (about 800 lines); [`contract`] holds the ten components and the Zod checks that
//! follow it. Not ported, since nothing in a block can reach them: `Query`, `Mutation`, `$state` and the `Each`,
//! `Sort`, `Filter` builtins.
//!
//! Streaming, as `GenerativeUI.tsx`: the block being written draws whatever parses so far with its buttons off;
//! a finished block that has no root, or was cut short, is shown as code; so is one over a cap or with no host to
//! take its buttons' messages (a button then stays off).

pub mod code;
pub mod contract;
pub mod fixture;
pub mod lang;
mod view;

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use gpui::{AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div, px};

pub use view::{BLOCK_MARGIN, SendHandler, Surface};

use contract::{Block, parse_block, text_over_limit};

thread_local! {
    static PARSED: RefCell<HashMap<SharedString, Arc<Block>>> = RefCell::new(HashMap::new());
}

/// How many parses are kept; more clears them all. A streaming block parses again on every flush, so this is
/// mostly its previous texts.
const PARSE_CACHE_LIMIT: usize = 128;

/// `parseGenui`, once per text.
pub fn parse_cached(code: &SharedString) -> Arc<Block> {
    if let Some(found) = PARSED.with(|cache| cache.borrow().get(code).cloned()) {
        return found;
    }
    let block = Arc::new(parse_block(code));
    PARSED.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() >= PARSE_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(code.clone(), block.clone());
    });
    block
}

fn fingerprint(code: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    code.hash(&mut hasher);
    hasher.finish()
}

/// An `openui` fence: the components, or its source as code (`GenerativeUI`).
pub fn render_block(code: SharedString, streaming: bool, send: Option<SendHandler>, window: &mut Window, cx: &mut App) -> AnyElement {
    if text_over_limit(&code) {
        return code::code_block("openui", &code, "generative-ui-block", cx);
    }
    let block = parse_cached(&code);
    let rootless = block.root.is_none() || block.incomplete;
    if rootless && !streaming {
        return code::code_block("openui", &code, "generative-ui-block", cx);
    }
    let surface = Surface { streaming, send, key: fingerprint(&code) };
    div()
        .debug_selector(|| "generative-ui-block".into())
        .my(px(BLOCK_MARGIN))
        .w_full()
        .min_w_0()
        .child(view::render(&block, &surface, window, cx))
        .into_any_element()
}
