//! MCP servers as Settings › MCP shows them: the rules of `packages/shared/src/mcp.ts` (grouping the accounts'
//! checks into rows, the summary and detail lines, remove and edit targets, the sheet's validation and the
//! catalog of hosted services). Pure data and functions; the page and the sheet draw them.

use std::collections::BTreeMap;

use crate::data::Provider;

/// Header and env values leave the computer as this; a save that sends it back keeps the stored value.
pub const SECRET_MASK: &str = "••••••";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChipState {
    Connected,
    Failed,
    NeedsSignIn,
    Pending,
    Disabled,
    Unchecked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Command,
    Url,
    Connector,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    User,
    Project,
    Local,
    Plugin,
    ClaudeAi,
    BuiltIn,
    Everywhere,
}

/// One server as one account loads it. `detail` is the URL or the command line.
#[derive(Clone, Debug, PartialEq)]
pub struct ServerReport {
    pub name: String,
    pub transport: Transport,
    pub scope: Scope,
    pub state: ChipState,
    pub tools: u32,
    pub error: Option<String>,
    pub detail: Option<String>,
    pub shadowed_by: Option<Provider>,
    /// The provider's own config switches it off, so Milagre's switch cannot turn it on.
    pub disabled_by_provider: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub provider: Provider,
    pub account_id: String,
    pub label: String,
}

impl Account {
    pub fn key(&self) -> String {
        format!("{}:{}", self.provider.id(), self.account_id)
    }
}

/// The answer to `mcp:check`. `problem` is set when the account could not be checked; `servers` is then empty.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountCheck {
    pub account: Account,
    pub problem: Option<String>,
    pub servers: Vec<ServerReport>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Chip {
    pub account: Account,
    pub scope: Scope,
    pub state: ChipState,
    pub tools: u32,
    pub error: Option<String>,
    pub shadowed_by: Option<Provider>,
    pub disabled_by_provider: bool,
}

impl Chip {
    pub fn key(&self) -> String {
        self.account.key()
    }

    /// "Claude · personal", or just "Antigravity" when the account has no name of its own.
    pub fn account_name(&self) -> String {
        let provider = self.account.provider.name();
        if !self.account.label.is_empty() && self.account.label != provider {
            format!("{provider} · {}", self.account.label)
        } else {
            provider.to_string()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub name: String,
    pub transport: Transport,
    pub detail: Option<String>,
    pub editable: bool,
    pub everywhere: bool,
    pub source: Option<String>,
    pub chips: Vec<Chip>,
}

impl Row {
    /// The name without the group it already sits under: "notion" for `plugin:engineering:notion`, "Gmail" for
    /// `claude.ai Gmail`.
    pub fn short_name(&self) -> String {
        if self.source.is_none() {
            return self.name.clone();
        }
        let name = match self.name.strip_prefix("plugin:") {
            Some(rest) => rest.split_once(':').map_or(rest, |(_, name)| name),
            None => self.name.as_str(),
        };
        name.strip_prefix("claude.ai ").unwrap_or(name).to_string()
    }

    pub fn failed_chip(&self) -> Option<&Chip> {
        self.chips.iter().find(|chip| chip.state == ChipState::Failed)
    }

    pub fn needs_sign_in(&self) -> bool {
        self.transport != Transport::Command && self.chips.iter().any(|chip| chip.state == ChipState::NeedsSignIn)
    }
}

/// Where a saved server goes: Milagre's own list, or one provider's user config.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Everywhere,
    Claude,
    Codex,
}

impl Target {
    pub const ALL: [Target; 3] = [Target::Everywhere, Target::Claude, Target::Codex];

    pub fn id(self) -> &'static str {
        match self {
            Target::Everywhere => "everywhere",
            Target::Claude => "claude",
            Target::Codex => "codex",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Target::Everywhere => "Everywhere",
            Target::Claude => "Claude only",
            Target::Codex => "Codex only",
        }
    }

    pub fn hint(self) -> &'static str {
        match self {
            Target::Everywhere => "Milagre Chats on every provider",
            Target::Claude => "Written to Claude’s config",
            Target::Codex => "Written to Codex’s config",
        }
    }

    fn place(self) -> &'static str {
        match self {
            Target::Everywhere => "Everywhere",
            Target::Claude => "Claude’s config",
            Target::Codex => "Codex’s config",
        }
    }

    pub fn from_id(id: &str) -> Option<Target> {
        Target::ALL.into_iter().find(|target| target.id() == id)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrlKind {
    Http,
    Sse,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Definition {
    Url { name: String, kind: UrlKind, url: String, headers: Vec<(String, String)> },
    Stdio { name: String, command: String, args: Vec<String>, env: Vec<(String, String)> },
}

impl Definition {
    pub fn name(&self) -> &str {
        match self {
            Definition::Url { name, .. } | Definition::Stdio { name, .. } => name,
        }
    }

    pub fn is_url(&self) -> bool {
        matches!(self, Definition::Url { .. })
    }
}

/// Official hosted services (checked against their setup docs on 2026-10-31). Custom servers use the same save
/// path. The desktop also draws each service's Simple Icons glyph; here the tile shows the initial.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    pub token: bool,
    pub docs_url: &'static str,
    pub token_url: Option<&'static str>,
}

const fn browser(
    id: &'static str,
    name: &'static str,
    description: &'static str,
    url: &'static str,
    docs_url: &'static str,
) -> CatalogEntry {
    CatalogEntry { id, name, description, url, token: false, docs_url, token_url: None }
}

pub const CATALOG: [CatalogEntry; 15] = [
    CatalogEntry {
        id: "github",
        name: "GitHub",
        description: "Repositories, issues, and pull requests.",
        url: "https://api.githubcopilot.com/mcp/",
        token: true,
        docs_url: "https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-claude.md",
        token_url: Some("https://github.com/settings/personal-access-tokens/new"),
    },
    browser("linear", "Linear", "Issues, projects, and team planning.", "https://mcp.linear.app/mcp", "https://linear.app/docs/mcp"),
    browser(
        "notion",
        "Notion",
        "Pages, databases, and workspace search.",
        "https://mcp.notion.com/mcp",
        "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    ),
    browser("sentry", "Sentry", "Errors, performance, and debugging.", "https://mcp.sentry.dev/mcp", "https://mcp.sentry.dev/"),
    browser(
        "supabase",
        "Supabase",
        "Projects, databases, and development tools.",
        "https://mcp.supabase.com/mcp",
        "https://supabase.com/docs/guides/ai-tools/mcp",
    ),
    browser(
        "vercel",
        "Vercel",
        "Projects, deployments, and deployment logs.",
        "https://mcp.vercel.com",
        "https://vercel.com/docs/agent-resources/vercel-mcp",
    ),
    browser("stripe", "Stripe", "Payments, customers, and subscriptions.", "https://mcp.stripe.com", "https://docs.stripe.com/mcp"),
    browser(
        "upstash",
        "Upstash",
        "Redis, queues, workflows, and vector databases.",
        "https://mcp.upstash.com/mcp",
        "https://upstash.com/docs/agent-resources/mcp",
    ),
    browser(
        "neon",
        "Neon",
        "Postgres databases, branches, and SQL queries.",
        "https://mcp.neon.tech/mcp",
        "https://neon.com/docs/ai/neon-mcp-server",
    ),
    browser(
        "atlassian",
        "Atlassian",
        "Jira issues, Confluence pages, and Bitbucket repositories.",
        "https://mcp.atlassian.com/v2/mcp",
        "https://atlassian.github.io/atlassian-mcp-server/",
    ),
    browser(
        "cloudflare",
        "Cloudflare",
        "Workers, DNS, storage, and account configuration.",
        "https://mcp.cloudflare.com/mcp",
        "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
    ),
    browser(
        "miro",
        "Miro",
        "Boards, diagrams, and team collaboration.",
        "https://mcp.miro.com/",
        "https://developers.miro.com/docs/miro-mcp-server-frequently-asked-questions",
    ),
    browser(
        "todoist",
        "Todoist",
        "Tasks, projects, due dates, and priorities.",
        "https://ai.todoist.net/mcp",
        "https://developer.todoist.com/",
    ),
    browser(
        "webflow",
        "Webflow",
        "Sites, CMS content, and website design.",
        "https://mcp.webflow.com/mcp",
        "https://developers.webflow.com/mcp/reference/getting-started",
    ),
    browser(
        "intercom",
        "Intercom (US)",
        "Support conversations and contacts in US-hosted workspaces.",
        "https://mcp.intercom.com/mcp",
        "https://developers.intercom.com/docs/guides/mcp",
    ),
];

/// The services whose name or description holds every word of the query (`searchMcpCatalog`).
pub fn search_catalog(query: &str) -> Vec<CatalogEntry> {
    let query = query.trim().to_lowercase();
    let words: Vec<&str> = query.split_whitespace().collect();
    CATALOG
        .iter()
        .filter(|entry| {
            let haystack = format!("{} {}", entry.name, entry.description).to_lowercase();
            words.iter().all(|word| haystack.contains(word))
        })
        .copied()
        .collect()
}

/// A new definition each time; a previous service's secret must never carry into another one.
pub fn catalog_definition(entry: &CatalogEntry, token: &str) -> Result<Definition, String> {
    let token = token.trim();
    let token = match token.get(..6) {
        Some(head) if head.eq_ignore_ascii_case("bearer") && token[6..].chars().next().is_none_or(char::is_whitespace) => {
            token[6..].trim_start()
        }
        _ => token,
    };
    if entry.token && (token.is_empty() || token.chars().any(char::is_whitespace) || token == SECRET_MASK) {
        return Err("Enter a valid personal access token.".to_string());
    }
    let headers = if entry.token { vec![("Authorization".to_string(), format!("Bearer {token}"))] } else { Vec::new() };
    Ok(Definition::Url { name: entry.id.to_string(), kind: UrlKind::Http, url: entry.url.to_string(), headers })
}

pub fn catalog_auth_hint(entry: &CatalogEntry, remote: bool) -> String {
    if entry.token {
        "Use a personal access token with access to the repositories you want to work with.".to_string()
    } else if remote {
        "After adding, finish sign-in in Milagre's MCP settings on the connected computer.".to_string()
    } else {
        format!("Your browser opens if {} needs you to sign in. Choose the account and access to allow.", entry.name)
    }
}

fn source_of(name: &str, scope: Scope) -> String {
    match scope {
        Scope::Project => "Project".to_string(),
        Scope::Local => "Local".to_string(),
        Scope::ClaudeAi => "claude.ai connectors".to_string(),
        Scope::Plugin => match name.strip_prefix("plugin:").and_then(|rest| rest.split_once(':')) {
            Some((plugin, _)) if !plugin.is_empty() => format!("Plugin · {plugin}"),
            _ => "Plugin".to_string(),
        },
        _ => "Built in".to_string(),
    }
}

/// Order of the outside groups: projects, local, plugins, claude.ai connectors, built in.
pub fn source_rank(source: &str) -> u8 {
    match source {
        "Project" => 0,
        "Local" => 1,
        s if s.starts_with("Plugin") => 2,
        "claude.ai connectors" => 3,
        _ => 4,
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grouped {
    /// URL or connector rows with a chip that needs sign-in.
    pub attention: Vec<Row>,
    /// Every editable row, those needing sign-in included (they keep their switches, Edit and Remove).
    pub user: Vec<Row>,
    /// The outside rows that do not need sign-in, by source.
    pub other: Vec<(String, Vec<Row>)>,
}

/// Rows by server name (`groupMcpRows`).
pub fn group_rows(checks: &[AccountCheck]) -> Grouped {
    let mut rows: BTreeMap<String, Row> = BTreeMap::new();
    for check in checks.iter().filter(|check| check.problem.is_none()) {
        for server in &check.servers {
            let row = rows.entry(server.name.clone()).or_insert_with(|| Row {
                name: server.name.clone(),
                transport: server.transport,
                detail: server.detail.clone(),
                editable: false,
                everywhere: false,
                source: None,
                chips: Vec::new(),
            });
            row.chips.push(Chip {
                account: check.account.clone(),
                scope: server.scope,
                state: server.state,
                tools: server.tools,
                error: server.error.clone(),
                shadowed_by: server.shadowed_by,
                disabled_by_provider: server.disabled_by_provider,
            });
            if row.detail.is_none() {
                row.detail.clone_from(&server.detail);
            }
            row.editable |= matches!(server.scope, Scope::User | Scope::Everywhere);
            row.everywhere |= server.scope == Scope::Everywhere;
        }
    }
    // `localeCompare` order: case-insensitive first.
    let mut sorted: Vec<Row> = rows.into_values().collect();
    sorted.sort_by_key(|row| (row.name.to_lowercase(), row.name.clone()));
    for row in sorted.iter_mut().filter(|row| !row.editable) {
        row.source = Some(source_of(&row.name, row.chips.first().map_or(Scope::BuiltIn, |chip| chip.scope)));
    }
    let attention = sorted.iter().filter(|row| row.needs_sign_in()).cloned().collect();
    let user = sorted.iter().filter(|row| row.editable).cloned().collect();
    let mut groups: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for row in sorted.iter().filter(|row| !row.editable && !row.needs_sign_in()) {
        groups.entry(row.source.clone().unwrap_or_else(|| "Built in".to_string())).or_default().push(row.clone());
    }
    let mut other: Vec<(String, Vec<Row>)> = groups.into_iter().collect();
    other.sort_by(|a, b| source_rank(&a.0).cmp(&source_rank(&b.0)).then_with(|| a.0.cmp(&b.0)));
    Grouped { attention, user, other }
}

fn is_config_provider(provider: Provider) -> bool {
    matches!(provider, Provider::Claude | Provider::Codex)
}

fn provider_target(provider: Provider) -> Option<Target> {
    match provider {
        Provider::Claude => Some(Target::Claude),
        Provider::Codex => Some(Target::Codex),
        _ => None,
    }
}

/// Every config a remove must reach: Everywhere if the row is there, and each Claude or Codex user config holding it.
pub fn remove_targets(row: &Row) -> Vec<Target> {
    let mut targets = Vec::new();
    if row.everywhere {
        targets.push(Target::Everywhere);
    }
    for chip in row.chips.iter().filter(|chip| chip.scope == Scope::User && is_config_provider(chip.account.provider)) {
        if let Some(target) = provider_target(chip.account.provider)
            && !targets.contains(&target)
        {
            targets.push(target);
        }
    }
    targets
}

/// "Everywhere, Claude’s config and Codex’s config": where a remove reaches.
pub fn target_places(targets: &[Target]) -> String {
    let places: Vec<&str> = targets.iter().map(|target| target.place()).collect();
    match places.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        Some((last, _)) => (*last).to_string(),
        None => String::new(),
    }
}

/// The config Edit reads and writes: Everywhere, else the default account's user config, else the first user config.
pub fn edit_target(row: &Row) -> Target {
    if row.everywhere {
        return Target::Everywhere;
    }
    let user: Vec<&Chip> = row.chips.iter().filter(|chip| chip.scope == Scope::User && is_config_provider(chip.account.provider)).collect();
    user.iter()
        .find(|chip| chip.account.account_id == "default")
        .or(user.first())
        .and_then(|chip| provider_target(chip.account.provider))
        .unwrap_or(Target::Everywhere)
}

fn state_copy(state: ChipState) -> &'static str {
    match state {
        ChipState::Connected => "Connected",
        ChipState::Failed => "Failed",
        ChipState::NeedsSignIn => "Needs sign-in",
        ChipState::Pending => "Checking",
        ChipState::Disabled => "Off in Milagre Chats",
        ChipState::Unchecked => "Loads in Chats",
    }
}

/// "Connected" for one chip; "2 of 3 connected"; "1 of 2 on" once any chip is off.
pub fn summary(row: &Row) -> String {
    if let [only] = row.chips.as_slice() {
        return state_copy(only.state).to_string();
    }
    if row.chips.iter().any(|chip| chip.state == ChipState::Disabled) {
        let on = row.chips.iter().filter(|chip| chip.state != ChipState::Disabled).count();
        return format!("{on} of {} on", row.chips.len());
    }
    let checked: Vec<&Chip> = row.chips.iter().filter(|chip| chip.state != ChipState::Unchecked).collect();
    if checked.is_empty() {
        return state_copy(ChipState::Unchecked).to_string();
    }
    format!("{} of {} connected", checked.iter().filter(|chip| chip.state == ChipState::Connected).count(), checked.len())
}

/// The host of an http(s) URL: the part `new URL(..).host` gives.
fn url_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?;
    (!host.is_empty()).then_some(host)
}

/// "URL · mcp.linear.app", "Command · npx …", "claude.ai connector".
pub fn transport_line(transport: Transport, detail: Option<&str>) -> String {
    match transport {
        Transport::Connector => "claude.ai connector".to_string(),
        Transport::Command => detail.map_or_else(|| "Command".to_string(), |detail| format!("Command · {detail}")),
        Transport::Url => match detail {
            None => "URL".to_string(),
            Some(detail) => format!("URL · {}", url_host(detail).unwrap_or(detail)),
        },
    }
}

/// One account's line in an open row.
pub fn chip_line(chip: &Chip) -> String {
    if chip.state == ChipState::Failed {
        return chip.error.clone().unwrap_or_else(|| state_copy(ChipState::Failed).to_string());
    }
    if chip.state == ChipState::Disabled && chip.disabled_by_provider {
        return format!("Off in {}’s config", chip.account.provider.name());
    }
    if chip.state != ChipState::Connected {
        return state_copy(chip.state).to_string();
    }
    let mut parts = vec![format!("Connected · {} tools", chip.tools)];
    if chip.scope == Scope::Everywhere {
        parts.push("from Everywhere".to_string());
    }
    if let Some(provider) = chip.shadowed_by {
        parts.push(format!("uses {}’s own", provider.name()));
    }
    parts.join(" · ")
}

/// The sheet's copy for the first problem, or `None`.
pub fn validate(server: &Definition) -> Option<String> {
    let name = server.name();
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Some("Use letters, numbers, - and _ only.".to_string());
    }
    if name == "milagre" {
        return Some("milagre is Milagre’s own server. Pick another name.".to_string());
    }
    match server {
        Definition::Stdio { command, env, .. } => {
            if command.trim().is_empty() {
                return Some("Enter the command to run.".to_string());
            }
            env.iter().any(|(key, _)| key.trim().is_empty()).then(|| "Every variable needs a name.".to_string())
        }
        Definition::Url { url, headers, .. } => {
            let scheme_ok = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).is_some_and(|rest| !rest.is_empty());
            if !scheme_ok || url.chars().any(char::is_whitespace) {
                return Some("Enter an http or https URL.".to_string());
            }
            headers.iter().any(|(key, _)| key.trim().is_empty()).then(|| "Every header needs a name.".to_string())
        }
    }
}

/// "Checked 12 s ago" counter text for the intro line.
pub fn intro_status(checking: bool, seconds: Option<u64>) -> String {
    if checking {
        " Checking…".to_string()
    } else if let Some(seconds) = seconds {
        format!(" Checked {seconds} s ago.")
    } else {
        String::new()
    }
}
