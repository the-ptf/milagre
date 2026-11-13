//! The rules behind a Project's Settings page, ported from `packages/shared/src/branch-policy.mjs` (the Branches
//! group), `lib/files-to-copy.ts` (the Files to copy preview), the `iconDataUrl` scale in `Settings.tsx`, and the
//! 600 ms autosave the page uses for its text fields.
//!
//! `branch_slug` folds only ASCII (the TypeScript normalises accents first); Settings previews with a fixed slug, so
//! the difference never shows.

pub const BRANCH_TITLE: &str = "Branches";
pub const BRANCH_FOOTER: &str = "Applies to new Worktrees. Existing branches keep their names.";
pub const BRANCH_EXAMPLE: &str = "Example";
pub const BRANCH_REPOSITORY: &str = "Set in .milagre/worktree.json";
pub const BRANCH_RESET: &str = "Reset to defaults";

/// One field's label, description and placeholder (`BRANCH_COPY`).
pub struct FieldCopy {
    pub label: &'static str,
    pub description: &'static str,
    pub placeholder: &'static str,
}

pub const TEMPLATE_COPY: FieldCopy = FieldCopy {
    label: "Branch name",
    description: "Built from the parts below. Add ? to skip a missing one, like {ticket?}. Empty uses Milagre's naming.",
    placeholder: "milagre/{slug}-{suffix}",
};
pub const USERNAME_COPY: FieldCopy = FieldCopy { label: "Username", description: "Fills {username}.", placeholder: "your-name" };
pub const DASHES_COPY: FieldCopy =
    FieldCopy { label: "Dashes only", description: "Lowercase letters, numbers and dashes. No slashes.", placeholder: "" };
pub const BASE_COPY: FieldCopy = FieldCopy {
    label: "Base branch",
    description: "New Chats start from it unless you pick another. Empty uses the current branch.",
    placeholder: "Current branch",
};
pub const TRACK_COPY: FieldCopy =
    FieldCopy { label: "Track the base branch", description: "Off leaves the upstream unset until the first push.", placeholder: "" };
pub const INSTRUCTIONS_COPY: FieldCopy = FieldCopy {
    label: "Agent instructions",
    description: "Conventions the agent follows when it names or renames a branch.",
    placeholder: "Use the Linear key when there is one",
};

/// `BranchPolicy`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BranchPolicy {
    pub template: String,
    pub username: String,
    pub dashes_only: bool,
    pub base_branch: String,
    pub track_base: bool,
    pub instructions: String,
}

/// The fields a layer sets (`Partial<BranchPolicy>`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PartialPolicy {
    pub template: Option<String>,
    pub username: Option<String>,
    pub dashes_only: Option<bool>,
    pub base_branch: Option<String>,
    pub track_base: Option<bool>,
    pub instructions: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Template,
    Username,
    DashesOnly,
    BaseBranch,
    TrackBase,
    Instructions,
}

pub const FIELDS: [Field; 6] =
    [Field::Template, Field::Username, Field::DashesOnly, Field::BaseBranch, Field::TrackBase, Field::Instructions];

impl PartialPolicy {
    pub fn has(&self, field: Field) -> bool {
        match field {
            Field::Template => self.template.is_some(),
            Field::Username => self.username.is_some(),
            Field::DashesOnly => self.dashes_only.is_some(),
            Field::BaseBranch => self.base_branch.is_some(),
            Field::TrackBase => self.track_base.is_some(),
            Field::Instructions => self.instructions.is_some(),
        }
    }

    pub fn is_empty(&self) -> bool {
        FIELDS.iter().all(|field| !self.has(*field))
    }

    /// Lays this partial over a policy.
    pub fn apply(&self, mut base: BranchPolicy) -> BranchPolicy {
        if let Some(v) = &self.template {
            base.template = v.clone();
        }
        if let Some(v) = &self.username {
            base.username = v.clone();
        }
        if let Some(v) = self.dashes_only {
            base.dashes_only = v;
        }
        if let Some(v) = &self.base_branch {
            base.base_branch = v.clone();
        }
        if let Some(v) = self.track_base {
            base.track_base = v;
        }
        if let Some(v) = &self.instructions {
            base.instructions = v.clone();
        }
        base
    }
}

/// `BranchPolicySettings`: the personal layer, the repository's own, and what applies.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BranchSettings {
    pub local: PartialPolicy,
    pub repository: PartialPolicy,
}

impl BranchSettings {
    /// Defaults, then the personal layer, then the repository's (`.milagre/worktree.json` wins).
    pub fn effective(&self) -> BranchPolicy {
        self.repository.apply(self.local.apply(BranchPolicy::default()))
    }
}

/// `branchSlug`: lowercase words of letters and digits, at most five and 40 characters, joined with dashes.
pub fn branch_slug(text: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words.truncate(5);
    let joined: String = words.join("-").chars().take(40).collect();
    joined.trim_end_matches('-').to_string()
}

/// `validBranchName`.
pub fn valid_branch_name(branch: &str) -> bool {
    if branch.is_empty()
        || branch.starts_with('-')
        || branch == "@"
        || branch.contains("@{")
        || branch == "HEAD"
        || branch.starts_with("refs/")
    {
        return false;
    }
    if branch.chars().any(|c| (c as u32) < 0x21 || c as u32 == 0x7f || " ~^:?*[\\".contains(c)) {
        return false;
    }
    if branch.contains("..") || branch.starts_with('/') || branch.ends_with('/') || branch.ends_with('.') || branch.contains("//") {
        return false;
    }
    branch.split('/').all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
}

/// The tokens a template may use, in the order of the chips.
pub const BRANCH_TOKENS: [&str; 4] = ["username", "ticket", "slug", "suffix"];

/// One `[-/]?\{token\??\}` found in a template: where it starts and ends (byte offsets), its token and whether `?`.
struct TokenMatch {
    start: usize,
    end: usize,
    brace: usize,
    token: &'static str,
    optional: bool,
}

fn token_matches(template: &str) -> Vec<TokenMatch> {
    let bytes = template.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = template[at..].find('{') {
        let brace = at + offset;
        let rest = &template[brace + 1..];
        let hit = BRANCH_TOKENS.iter().find_map(|token| {
            let after = rest.strip_prefix(token)?;
            let (optional, after) = after.strip_prefix('?').map_or((false, after), |a| (true, a));
            after.starts_with('}').then_some((*token, optional, brace + 1 + token.len() + usize::from(optional) + 1))
        });
        match hit {
            Some((token, optional, end)) => {
                let sep = brace > at && matches!(bytes[brace - 1], b'-' | b'/');
                let start = if sep { brace - 1 } else { brace };
                found.push(TokenMatch { start, end, brace, token, optional });
                at = end;
            }
            None => at = brace + 1,
        }
    }
    found
}

/// `validatePolicyBranch`.
pub fn validate_policy_branch(branch: &str, policy: &BranchPolicy) -> Result<String, String> {
    if !valid_branch_name(branch) {
        return Err(format!("\"{branch}\" is not a valid branch name."));
    }
    if policy.dashes_only {
        let ok = branch.split('-').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        if !ok {
            return Err("This Project requires lowercase branch names with letters, numbers and dashes only.".into());
        }
    }
    Ok(branch.to_string())
}

/// Removes `ticket` (as a whole word, any case) from `slug`, the way the template's own `{ticket}` slot takes it.
fn without_ticket(slug: &str, ticket: &str) -> String {
    let lower = slug.to_lowercase();
    let needle = ticket.to_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(offset) = lower[at..].find(&needle) {
        let start = at + offset;
        let end = start + needle.len();
        let word = |c: char| c.is_alphanumeric() || c == '_';
        let before = slug[..start].chars().next_back().is_none_or(|c| !word(c));
        let after = slug[end..].chars().next().is_none_or(|c| !word(c));
        out.push_str(&slug[at..start]);
        out.push_str(if before && after { " " } else { &slug[start..end] });
        at = end;
    }
    out.push_str(&slug[at..]);
    out
}

/// `formatPolicyBranch`: the branch a policy names for a slug, ticket and suffix.
pub fn format_policy_branch(policy: &BranchPolicy, slug: &str, ticket: &str, suffix: &str, preview: bool) -> Result<String, String> {
    let template = if policy.template.is_empty() {
        if policy.dashes_only { "{slug}-{suffix}".to_string() } else { "milagre/{slug}-{suffix}".to_string() }
    } else {
        policy.template.clone()
    };
    let task = if template.contains("{ticket") && !ticket.is_empty() { without_ticket(slug, ticket) } else { slug.to_string() };
    let slug_value = {
        let s = branch_slug(&task);
        if s.is_empty() { "chat".to_string() } else { s }
    };
    let value = |token: &str| -> String {
        match token {
            "slug" => slug_value.clone(),
            "username" => policy.username.clone(),
            "ticket" => ticket.to_lowercase(),
            _ => suffix.to_string(),
        }
    };
    let mut rendered = String::new();
    let mut at = 0;
    for m in token_matches(&template) {
        rendered.push_str(&template[at..m.start]);
        let literal = &template[m.start..m.end];
        let filled = value(m.token);
        if filled.is_empty() {
            if m.optional {
                // Dropped with its separator.
            } else if preview && m.token == "username" {
                rendered.push_str(&literal.replacen("{username}", "username", 1));
            } else {
                return Err(format!("The branch template needs a {0}. Choose one before creating a Worktree, or use {{{0}?}}.", m.token));
            }
        } else {
            rendered.push_str(&template[m.start..m.brace]);
            rendered.push_str(&filled);
        }
        at = m.end;
        let _ = literal;
    }
    rendered.push_str(&template[at..]);
    validate_policy_branch(&rendered, policy)
}

/// `validateBranchPolicy`: the first thing wrong with a policy, if anything.
pub fn validate_branch_policy(policy: &BranchPolicy) -> Result<(), String> {
    if !policy.template.is_empty() {
        let mut stripped = String::new();
        let mut at = 0;
        for m in token_matches(&policy.template) {
            // The tokens themselves, without the separator before them.
            stripped.push_str(&policy.template[at..m.brace]);
            at = m.end;
        }
        stripped.push_str(&policy.template[at..]);
        if !policy.template.contains("{slug}") || stripped.contains('{') || stripped.contains('}') {
            return Err(
                "A branch template must include {slug} and may only use {username}, {ticket}, {suffix} and their optional forms.".into()
            );
        }
    }
    if !policy.base_branch.is_empty() && !valid_branch_name(&policy.base_branch) {
        return Err("Choose a valid default base branch name.".into());
    }
    format_policy_branch(policy, "fix-login", "ENG-123", "ab12", true).map(|_| ())
}

/// What Settings shows for a draft (`branchPolicyCheck`): the example name, or which field is wrong and why.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PolicyCheck {
    pub preview: String,
    pub template: String,
    pub base_branch: String,
}

pub fn branch_policy_check(policy: &BranchPolicy) -> PolicyCheck {
    let mut result = PolicyCheck::default();
    if !policy.base_branch.is_empty() && !valid_branch_name(&policy.base_branch) {
        result.base_branch = "Not a valid branch name.".into();
    }
    let without_base = BranchPolicy { base_branch: String::new(), ..policy.clone() };
    match validate_branch_policy(&without_base).and_then(|()| format_policy_branch(&without_base, "fix-login", "ENG-123", "ab12", true)) {
        Ok(preview) => result.preview = preview,
        Err(message) => result.template = message,
    }
    result
}

/// `branchPolicyOverrides`: the personal overrides to save: every field the repository doesn't set, kept from the draft
/// when it differs from the default or was already overridden.
pub fn branch_policy_overrides(settings: &BranchSettings, draft: &BranchPolicy) -> PartialPolicy {
    let default = BranchPolicy::default();
    let keep = |field: Field, differs: bool| !settings.repository.has(field) && (differs || settings.local.has(field));
    PartialPolicy {
        template: keep(Field::Template, draft.template != default.template).then(|| draft.template.clone()),
        username: keep(Field::Username, draft.username != default.username).then(|| draft.username.clone()),
        dashes_only: keep(Field::DashesOnly, draft.dashes_only != default.dashes_only).then_some(draft.dashes_only),
        base_branch: keep(Field::BaseBranch, draft.base_branch != default.base_branch).then(|| draft.base_branch.clone()),
        track_base: keep(Field::TrackBase, draft.track_base != default.track_base).then_some(draft.track_base),
        instructions: keep(Field::Instructions, draft.instructions != default.instructions).then(|| draft.instructions.clone()),
    }
}

/// `insertToken`: the text to type at the caret for a token chip, with a dash before it when it would run into the
/// previous part.
pub fn token_text(before_caret: &str, token: &str) -> String {
    let glue = if !before_caret.is_empty() && !before_caret.ends_with(['-', '/', '_']) { "-" } else { "" };
    format!("{glue}{{{token}}}")
}

// -- Files to copy --------------------------------------------------------------------------------------------------

/// What the field shows when nothing is set, and what applies.
pub const DEFAULT_FILES_TO_COPY: &str = ".env*";

/// `parsePatterns`: one per line, blank lines dropped.
pub fn parse_patterns(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect()
}

/// `previewSentence`: "Matches 3 files: .env, .env.local, apps/web/.env".
pub fn preview_sentence(matches: &[String], shown: usize) -> String {
    if matches.is_empty() {
        return "Matches no files.".into();
    }
    let names = matches.iter().take(shown).cloned().collect::<Vec<_>>().join(", ");
    let more = if matches.len() > shown { format!(" and {} more", matches.len() - shown) } else { String::new() };
    format!("Matches {} {}: {names}{more}", matches.len(), if matches.len() == 1 { "file" } else { "files" })
}

fn glob(pattern: &[char], text: &[char]) -> bool {
    match pattern.first() {
        None => text.is_empty(),
        Some('*') if pattern.get(1) == Some(&'*') => {
            let rest = &pattern[2..];
            let rest = rest.strip_prefix(&['/']).unwrap_or(rest);
            (0..=text.len()).any(|skip| glob(rest, &text[skip..]))
        }
        Some('*') => (0..=text.len()).take_while(|&n| n == 0 || text[n - 1] != '/').any(|n| glob(&pattern[1..], &text[n..])),
        Some('?') => text.first().is_some_and(|&c| c != '/') && glob(&pattern[1..], &text[1..]),
        Some(&c) => text.first() == Some(&c) && glob(&pattern[1..], &text[1..]),
    }
}

/// One `.gitignore`-style pattern against a path (a lite port: `*`, `**`, `?`, a leading or inner `/` anchors, a
/// trailing `/` names a folder).
fn pattern_matches(pattern: &str, path: &str) -> bool {
    let dir_only = pattern.ends_with('/');
    let body = pattern.trim_end_matches('/');
    let anchored = body.starts_with('/') || body.contains('/');
    let body: Vec<char> = body.trim_start_matches('/').chars().collect();
    let segments: Vec<&str> = path.split('/').collect();
    let whole = |candidate: &str| glob(&body, &candidate.chars().collect::<Vec<_>>());
    if anchored {
        // The path, or a folder above it.
        (1..=segments.len()).any(|n| (!dir_only || n < segments.len()) && whole(&segments[..n].join("/")))
    } else {
        segments.iter().enumerate().any(|(ix, segment)| (!dir_only || ix + 1 < segments.len()) && whole(segment))
    }
}

/// The files of `candidates` the patterns copy: `!` undoes an earlier match, `#` starts a comment.
pub fn match_files(patterns: &[String], candidates: &[String]) -> Vec<String> {
    candidates
        .iter()
        .filter(|path| {
            let mut copied = false;
            for pattern in patterns.iter().filter(|p| !p.starts_with('#')) {
                if let Some(negated) = pattern.strip_prefix('!') {
                    if pattern_matches(negated, path) {
                        copied = false;
                    }
                } else if pattern_matches(pattern, path) {
                    copied = true;
                }
            }
            copied
        })
        .cloned()
        .collect()
}

// -- Icon -----------------------------------------------------------------------------------------------------------

/// The longest side an icon keeps: the phone gets the same image, and a full-size app icon would not fit.
pub const ICON_MAX_SIDE: f64 = 256.0;

/// `iconDataUrl`'s scale: the size an image of `width` by `height` is saved at.
pub fn icon_size(width: u32, height: u32) -> (u32, u32) {
    let longest = f64::from(width.max(height)).max(1.0);
    let scale = (ICON_MAX_SIDE / longest).min(1.0);
    ((f64::from(width) * scale).round() as u32, (f64::from(height) * scale).round() as u32)
}

// -- Autosave -------------------------------------------------------------------------------------------------------

/// How long after the last keystroke a text field saves.
pub const SAVE_DELAY_MS: i64 = 600;
/// How long after the last keystroke the Files to copy preview runs.
pub const PREVIEW_DELAY_MS: i64 = 300;

/// A debounce on a clock the caller supplies: each edit moves the deadline, a poll at or after it fires once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Debounce {
    delay: i64,
    due: Option<i64>,
}

impl Debounce {
    pub const fn new(delay: i64) -> Self {
        Debounce { delay, due: None }
    }

    /// A keystroke at `now`.
    pub fn edit(&mut self, now: i64) {
        self.due = Some(now + self.delay);
    }

    pub fn pending(&self) -> bool {
        self.due.is_some()
    }

    /// True once, when `now` has reached the deadline.
    pub fn fire(&mut self, now: i64) -> bool {
        if self.due.is_some_and(|due| now >= due) {
            self.due = None;
            return true;
        }
        false
    }

    /// Leaving the page saves what was typed last: true when something was waiting.
    pub fn flush(&mut self) -> bool {
        self.due.take().is_some()
    }

    pub fn cancel(&mut self) {
        self.due = None;
    }
}

/// A map of ignored files to the text a fixture checkout would hold; kept here so tests and the store agree.
pub fn fixture_ignored_files() -> Vec<String> {
    [".env", ".env.local", ".env.production", "apps/mobile/.env", "apps/web/.env.local", "config/secrets.json", ".DS_Store", "dist/app.js"]
        .map(str::to_string)
        .to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(template: &str) -> BranchPolicy {
        BranchPolicy { template: template.into(), ..BranchPolicy::default() }
    }

    #[test]
    fn slugs_fold_to_five_dashed_words() {
        assert_eq!(branch_slug("Fix the login bug on Safari today now"), "fix-the-login-bug-on");
        assert_eq!(branch_slug("  --Hello,  World!!  "), "hello-world");
        assert_eq!(branch_slug(&"abc ".repeat(30)), "abc-abc-abc-abc-abc");
        assert_eq!(branch_slug("!!!"), "");
    }

    #[test]
    fn branch_names_follow_git_rules() {
        for ok in ["main", "milagre/fix-login-ab12", "a/b.c", "v1.0"] {
            assert!(valid_branch_name(ok), "{ok}");
        }
        for bad in ["", "-x", "@", "a@{b", "HEAD", "refs/x", "a b", "a..b", "/a", "a/", "a.", "a//b", "a/.b", "a.lock", "a~b", "a:b"] {
            assert!(!valid_branch_name(bad), "{bad}");
        }
    }

    #[test]
    fn the_default_template_names_milagre_slug_suffix() {
        let check = branch_policy_check(&BranchPolicy::default());
        assert_eq!(check.preview, "milagre/fix-login-ab12");
        assert_eq!(check.template, "");
        let dashes = branch_policy_check(&BranchPolicy { dashes_only: true, ..BranchPolicy::default() });
        assert_eq!(dashes.preview, "fix-login-ab12");
    }

    #[test]
    fn templates_fill_tokens_and_drop_optional_ones() {
        assert_eq!(branch_policy_check(&policy("{username}/{ticket}-{slug}")).preview, "username/eng-123-fix-login");
        let named = BranchPolicy { username: "victor".into(), ..policy("{username}/{slug}-{suffix}") };
        assert_eq!(branch_policy_check(&named).preview, "victor/fix-login-ab12");
        // A missing optional part goes with the dash or slash before it.
        let no_ticket = format_policy_branch(&policy("feat/{ticket?}-{slug}"), "fix login", "", "", true).unwrap();
        assert_eq!(no_ticket, "feat-fix-login");
        let dropped = format_policy_branch(&policy("feat/{slug}-{suffix?}"), "fix login", "", "", true).unwrap();
        assert_eq!(dropped, "feat/fix-login");
        // The ticket is not repeated in the slug.
        let ticket = format_policy_branch(&policy("{ticket}-{slug}"), "ENG-123 fix login", "ENG-123", "", true).unwrap();
        assert_eq!(ticket, "eng-123-fix-login");
    }

    #[test]
    fn a_template_without_a_needed_part_says_so() {
        let error = format_policy_branch(&policy("{ticket}-{slug}"), "fix login", "", "", true).unwrap_err();
        assert_eq!(error, "The branch template needs a ticket. Choose one before creating a Worktree, or use {ticket?}.");
    }

    #[test]
    fn bad_templates_and_base_branches_are_reported() {
        let missing_slug = branch_policy_check(&policy("milagre/{suffix}"));
        assert_eq!(
            missing_slug.template,
            "A branch template must include {slug} and may only use {username}, {ticket}, {suffix} and their optional forms."
        );
        assert!(missing_slug.preview.is_empty());
        let stray = branch_policy_check(&policy("{slug}-{nope}"));
        assert!(stray.template.starts_with("A branch template must include {slug}"));
        let base = branch_policy_check(&BranchPolicy { base_branch: "a b".into(), ..BranchPolicy::default() });
        assert_eq!(base.base_branch, "Not a valid branch name.");
        assert_eq!(base.preview, "milagre/fix-login-ab12", "the base branch does not stop the example");
        let dashes = branch_policy_check(&BranchPolicy { dashes_only: true, ..policy("milagre/{slug}") });
        assert_eq!(dashes.template, "This Project requires lowercase branch names with letters, numbers and dashes only.");
    }

    #[test]
    fn overrides_keep_what_differs_and_skip_the_repository() {
        let settings = BranchSettings {
            local: PartialPolicy { username: Some("victor".into()), ..PartialPolicy::default() },
            repository: PartialPolicy { base_branch: Some("main".into()), ..PartialPolicy::default() },
        };
        let mut draft = settings.effective();
        assert_eq!(draft.username, "victor");
        assert_eq!(draft.base_branch, "main");
        draft.template = "{slug}".into();
        draft.base_branch = "ignored".into();
        let overrides = branch_policy_overrides(&settings, &draft);
        assert_eq!(overrides.template.as_deref(), Some("{slug}"));
        assert_eq!(overrides.username.as_deref(), Some("victor"));
        assert_eq!(overrides.base_branch, None, "the repository sets it");
        assert_eq!(overrides.dashes_only, None, "still the default");
        // A field already overridden stays, even when set back to the default.
        draft.username.clear();
        assert_eq!(branch_policy_overrides(&settings, &draft).username.as_deref(), Some(""));
    }

    #[test]
    fn chips_add_a_dash_only_when_it_would_run_in() {
        assert_eq!(token_text("", "username"), "{username}");
        assert_eq!(token_text("milagre/", "slug"), "{slug}");
        assert_eq!(token_text("milagre/{slug}", "suffix"), "-{suffix}");
        assert_eq!(token_text("a_", "ticket"), "{ticket}");
    }

    #[test]
    fn files_to_copy_match_like_gitignore() {
        let files = fixture_ignored_files();
        assert_eq!(
            match_files(&parse_patterns(DEFAULT_FILES_TO_COPY), &files),
            [".env", ".env.local", ".env.production", "apps/mobile/.env", "apps/web/.env.local"]
        );
        assert_eq!(match_files(&parse_patterns("/.env\n!/.env"), &files), Vec::<String>::new());
        assert_eq!(match_files(&parse_patterns("config/"), &files), ["config/secrets.json"]);
        assert_eq!(match_files(&parse_patterns("**/.env"), &files), [".env", "apps/mobile/.env"]);
        assert_eq!(match_files(&parse_patterns("# comment\n\n*.json"), &files), ["config/secrets.json"]);
        assert_eq!(match_files(&parse_patterns("apps/*/.env*"), &files), ["apps/mobile/.env", "apps/web/.env.local"]);
    }

    #[test]
    fn the_preview_sentence_counts_and_truncates() {
        assert_eq!(preview_sentence(&[], 6), "Matches no files.");
        assert_eq!(preview_sentence(&[".env".into()], 6), "Matches 1 file: .env");
        let many: Vec<String> = (1..=8).map(|n| format!("f{n}")).collect();
        assert_eq!(preview_sentence(&many, 6), "Matches 8 files: f1, f2, f3, f4, f5, f6 and 2 more");
        assert_eq!(parse_patterns("a\r\n\n  b  \n"), ["a", "b"]);
    }

    #[test]
    fn icons_scale_down_to_256_and_never_up() {
        assert_eq!(icon_size(1024, 512), (256, 128));
        assert_eq!(icon_size(200, 100), (200, 100));
        assert_eq!(icon_size(256, 256), (256, 256));
        assert_eq!(icon_size(3, 1000), (1, 256));
    }

    #[test]
    fn autosave_waits_for_a_quiet_600ms_on_a_fake_clock() {
        let mut save = Debounce::new(SAVE_DELAY_MS);
        assert!(!save.fire(10_000), "nothing was typed");
        save.edit(1_000);
        assert!(!save.fire(1_599));
        // Another keystroke moves the deadline.
        save.edit(1_500);
        assert!(!save.fire(2_099));
        assert!(save.fire(2_100));
        assert!(!save.fire(9_999), "it fires once");
        // Leaving the page flushes what is waiting.
        save.edit(5_000);
        assert!(save.pending());
        assert!(save.flush());
        assert!(!save.flush());
        let mut preview = Debounce::new(PREVIEW_DELAY_MS);
        preview.edit(0);
        assert!(preview.fire(300));
    }
}
