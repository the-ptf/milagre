//! Prompt logic after `packages/shared/src/prompt-skills.mjs`, `prompt-parts.mjs` and `prompt-mentions.mjs`:
//! slash skills, `@` file, Chat and computer mentions, `[Image #N]` tokens, quotes and the prompt title. Pure
//! functions over strings.
//!
//! **Offsets are UTF-8 byte offsets** into the prompt (what a Rust composer string model uses), where the
//! TypeScript's are UTF-16 code units. For ASCII prompts they are the same; [`text::utf16_to_byte`] and
//! [`text::byte_to_utf16`] convert a selection that arrives in UTF-16.

pub mod mentions;
pub mod parts;
pub mod skills;
pub mod text;
