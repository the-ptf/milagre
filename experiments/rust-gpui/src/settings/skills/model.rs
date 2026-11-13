//! The rules of `packages/shared/src/skill-catalog.ts` and the fixture skills Settings › Skills lists.

/// Where a skill comes from; the groups, in the order Settings shows them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Workspace,
    User,
    Bundled,
}

impl Scope {
    pub const ALL: [Scope; 3] = [Scope::Workspace, Scope::User, Scope::Bundled];

    pub fn id(self) -> &'static str {
        match self {
            Scope::Workspace => "workspace",
            Scope::User => "user",
            Scope::Bundled => "bundled",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Scope::Workspace => "Project",
            Scope::User => "User",
            Scope::Bundled => "Built-in",
        }
    }

    pub fn from_id(id: &str) -> Option<Scope> {
        Scope::ALL.into_iter().find(|scope| scope.id() == id)
    }
}

/// The CLI folders discovery reads (`.claude/skills`, ...), as filter choices.
pub const PROVIDERS: [(&str, &str); 4] = [("claude", "Claude"), ("codex", "Codex"), ("agents", "Agents"), ("gemini", "Gemini")];

pub fn provider_label(provider: &str) -> String {
    PROVIDERS
        .iter()
        .find(|(id, _)| *id == provider)
        .map(|(_, label)| (*label).to_string())
        .unwrap_or_else(|| if provider == "milagre" { "Milagre".to_string() } else { provider.to_string() })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub provider: String,
    pub scope: Scope,
}

/// A same-named skill another one hides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shadowed {
    pub path: String,
    pub provider: String,
    pub scope: Scope,
    pub shadowed_by: String,
}

/// Search matches name and description like the `/` menu; scope and provider narrow it further.
pub fn filter_skills<'a>(skills: &'a [Skill], query: &str, scope: Option<Scope>, provider: Option<&str>) -> Vec<&'a Skill> {
    let needle = query.trim().to_lowercase();
    skills
        .iter()
        .filter(|skill| {
            scope.is_none_or(|scope| skill.scope == scope)
                && provider.is_none_or(|provider| skill.provider == provider)
                && format!("{} {}", skill.name, skill.description).to_lowercase().contains(&needle)
        })
        .collect()
}

/// The groups with skills in them, in the Settings order.
pub fn group_skills<'a>(skills: &[&'a Skill]) -> Vec<(Scope, Vec<&'a Skill>)> {
    Scope::ALL
        .into_iter()
        .filter_map(|scope| {
            let list: Vec<&Skill> = skills.iter().copied().filter(|skill| skill.scope == scope).collect();
            (!list.is_empty()).then_some((scope, list))
        })
        .collect()
}

/// The same-named skills a winner hides.
pub fn shadowed_by<'a>(shadowed: &'a [Shadowed], skill: &Skill) -> Vec<&'a Shadowed> {
    shadowed.iter().filter(|item| item.shadowed_by == skill.path).collect()
}

/// A SKILL.md without its frontmatter, which the page shows as the name and description instead.
pub fn skill_body(content: &str) -> String {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(rest) = content.strip_prefix("---\n").or_else(|| content.strip_prefix("---\r\n")) else { return content.trim().to_string() };
    // The closing fence is a line of its own.
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return rest[offset + line.len()..].trim().to_string();
        }
        offset += line.len();
    }
    content.trim().to_string()
}

/// Guesses the home folder from the path (macOS and Linux layouts), and shortens the paths inside a warning.
pub fn shorten_home(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut at_boundary = true;
    while let Some(ch) = rest.chars().next() {
        if at_boundary {
            let root = ["/Users/", "/home/"].into_iter().find(|root| rest.starts_with(root));
            if let Some(root) = root {
                let after = &rest[root.len()..];
                let user_len = after.find(|c: char| c == '/' || c.is_whitespace()).unwrap_or(after.len());
                if user_len > 0 {
                    out.push('~');
                    rest = &after[user_len..];
                    at_boundary = false;
                    continue;
                }
            }
        }
        out.push(ch);
        at_boundary = ch.is_whitespace();
        rest = &rest[ch.len_utf8()..];
    }
    out
}

pub fn overrides_text(count: usize) -> String {
    format!("Overrides {count} other{}", if count == 1 { "" } else { "s" })
}

/// `skills:list`'s answer (`SkillCatalog`: `{skills, shadowed?, warnings}`); a skill of an unknown scope is left out.
pub fn catalog(value: &serde_json::Value) -> (Vec<Skill>, Vec<Shadowed>, Vec<String>) {
    let text = |item: &serde_json::Value, key: &str| item[key].as_str().unwrap_or_default().to_string();
    let list = |key: &str| value[key].as_array().cloned().unwrap_or_default();
    let skills = list("skills")
        .iter()
        .filter_map(|item| {
            Some(Skill {
                name: item["name"].as_str()?.to_string(),
                description: text(item, "description"),
                path: text(item, "path"),
                provider: text(item, "provider"),
                scope: Scope::from_id(item["scope"].as_str()?)?,
            })
        })
        .collect();
    let shadowed = list("shadowed")
        .iter()
        .filter_map(|item| {
            Some(Shadowed {
                path: item["path"].as_str()?.to_string(),
                provider: text(item, "provider"),
                scope: Scope::from_id(item["scope"].as_str()?)?,
                shadowed_by: item["shadowedBy"].as_str()?.to_string(),
            })
        })
        .collect();
    let warnings = list("warnings").iter().filter_map(|w| w.as_str().map(str::to_string)).collect();
    (skills, shadowed, warnings)
}

// ---- fixture ------------------------------------------------------------------------------------------------------

pub const PROJECT_PATH: &str = "/Users/victor/Code/personal/milagre-ade";
const HOME: &str = "/Users/victor";

fn skill(name: &str, description: &str, path: &str, provider: &str, scope: Scope) -> Skill {
    Skill { name: name.into(), description: description.into(), path: path.into(), provider: provider.into(), scope }
}

/// What skill discovery finds for the fixture Project, the same-named skills it hid and what it could not read.
pub fn fixture() -> (Vec<Skill>, Vec<Shadowed>, Vec<String>) {
    let project = |name: &str, description: &str, folder: &str, provider: &str| {
        skill(name, description, &format!("{PROJECT_PATH}/{folder}/{name}/SKILL.md"), provider, Scope::Workspace)
    };
    let user = |name: &str, description: &str, folder: &str, provider: &str| {
        skill(name, description, &format!("{HOME}/{folder}/{name}/SKILL.md"), provider, Scope::User)
    };
    let skills = vec![
        project(
            "release-train",
            "Cut a beta from main: merge the queue, tag, publish the OTA and announce it.",
            ".claude/skills",
            "claude",
        ),
        project(
            "design-council",
            "Run the five-judge design review harness on a desktop surface until every judge scores 9.",
            ".claude/skills",
            "claude",
        ),
        project("tldr", "Rewrite text so a skimming human can act on it and nothing in it smells like AI.", ".claude/skills", "claude"),
        project("pick-issue", "Pick the next GitHub issue for a Routine run and open its Worktree.", ".agents/skills", "agents"),
        user("grill-me", "Interview the user relentlessly about a plan or design before anything is built.", ".claude/skills", "claude"),
        user("handwritten", "Make a message read like a busy person typed it.", ".claude/skills", "claude"),
        user("tldr", "Shorten any reply into the next action first.", ".claude/skills", "claude"),
        user("paseo-committee", "Form a committee of two high-reasoning agents to do root cause analysis.", ".codex/skills", "codex"),
        user("review-pr", "Review a pull request against the team's checklist.", ".codex/skills", "codex"),
        skill("milagre-routines", "Create and run Routines and Heartbeats from a Chat.", "", "milagre", Scope::Bundled),
        skill("milagre-design", "Show a mockup on the Chat's Designs canvas.", "", "milagre", Scope::Bundled),
    ];
    let shadowed = vec![Shadowed {
        path: format!("{HOME}/.claude/skills/tldr/SKILL.md"),
        provider: "claude".into(),
        scope: Scope::User,
        shadowed_by: format!("{PROJECT_PATH}/.claude/skills/tldr/SKILL.md"),
    }];
    let warnings = vec![
        format!("{HOME}/.claude/skills/broken-skill/SKILL.md: the description is missing"),
        format!("{HOME}/.codex/skills/old-notes: no SKILL.md in this folder"),
    ];
    (skills, shadowed, warnings)
}

/// What `skills:read` answers for a skill, or why it could not.
pub fn read_skill(skill: &Skill) -> Result<String, String> {
    if skill.name == "review-pr" {
        return Err("ENOENT: the file was moved while the list was open".to_string());
    }
    let name = skill.name.as_str();
    Ok(format!(
        "---\nname: {name}\ndescription: Fixture skill\n---\n\n# {name}\n\nUse this when the task matches its description.\n\n## Steps\n\n1. Read the request and the files it names.\n2. Do the smallest change that works and run the checks.\n3. Report what changed, with the commit.\n\nPaths such as `src/settings/mod.rs` and commands such as `npm test -- --unit` stay in code.\n"
    ))
}
