//! The fixture standing in for the computer's `mcp:*` commands: the accounts, each account's check, and the
//! writes (toggle, remove, save, sign in). Nothing here talks to the daemon yet; the page calls these as it
//! would call `bridge.mcp.*` and re-checks afterwards.

use std::collections::BTreeMap;

use super::logic::{
    Account, AccountCheck, ChipState, Definition, SECRET_MASK, Scope, ServerReport, Target, Transport, UrlKind, edit_target,
};
use crate::data::Provider;

/// A server written to Milagre's own list (Everywhere) or to one provider's user config.
#[derive(Clone, Debug, PartialEq)]
struct Stored {
    def: Definition,
    target: Target,
}

#[derive(Clone, Debug)]
pub struct Host {
    accounts: Vec<Account>,
    stored: Vec<Stored>,
    /// (account key, server name) -> what the account says about it, when not the default "connected".
    overrides: BTreeMap<(String, String), Override>,
    /// Servers set up outside Milagre, per account key.
    outside: BTreeMap<String, Vec<ServerReport>>,
    /// A remove from this config fails (the file is read-only).
    pub fail_remove: Option<Target>,
    /// Accounts whose check cannot run.
    problems: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Override {
    state: ChipState,
    error: Option<String>,
}

fn account(provider: Provider, id: &str, label: &str) -> Account {
    Account { provider, account_id: id.to_string(), label: label.to_string() }
}

fn url_def(name: &str, url: &str, headers: &[(&str, &str)]) -> Definition {
    Definition::Url {
        name: name.to_string(),
        kind: UrlKind::Http,
        url: url.to_string(),
        headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

fn stdio_def(name: &str, command: &str, args: &[&str], env: &[(&str, &str)]) -> Definition {
    Definition::Stdio {
        name: name.to_string(),
        command: command.to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

fn report(name: &str, transport: Transport, scope: Scope, detail: &str, tools: u32) -> ServerReport {
    ServerReport {
        name: name.to_string(),
        transport,
        scope,
        state: ChipState::Connected,
        tools,
        error: None,
        detail: (!detail.is_empty()).then(|| detail.to_string()),
        shadowed_by: None,
        disabled_by_provider: false,
    }
}

fn with_state(mut report: ServerReport, state: ChipState) -> ServerReport {
    report.state = state;
    if state != ChipState::Connected {
        report.tools = 0;
    }
    report
}

/// How many tools the fixture's servers answer with.
fn tools_for(name: &str) -> u32 {
    let sum: u32 = name.bytes().map(u32::from).sum();
    6 + sum % 28
}

impl Default for Host {
    fn default() -> Self {
        Self::fixture()
    }
}

impl Host {
    pub fn fixture() -> Self {
        let personal = account(Provider::Claude, "default", "personal");
        let work = account(Provider::Claude, "work", "work");
        let codex = account(Provider::Codex, "default", "Codex");
        let accounts = vec![personal.clone(), work.clone(), codex.clone()];

        let stored = vec![
            Stored {
                def: stdio_def("filesystem", "npx", &["-y", "@modelcontextprotocol/server-filesystem", "/Users/victor/Code"], &[]),
                target: Target::Everywhere,
            },
            Stored { def: url_def("supabase", "https://mcp.supabase.com/mcp", &[]), target: Target::Everywhere },
            Stored { def: url_def("linear", "https://mcp.linear.app/mcp", &[]), target: Target::Claude },
            Stored {
                def: url_def(
                    "notion",
                    "https://mcp.notion.com/mcp",
                    &[("Authorization", "Bearer ntn_live_9f3a"), ("Notion-Version", "2022-06-28")],
                ),
                target: Target::Claude,
            },
            Stored {
                def: stdio_def("playwright", "npx", &["@playwright/mcp@latest", "--headless"], &[("PLAYWRIGHT_BROWSERS_PATH", "0")]),
                target: Target::Claude,
            },
            Stored { def: url_def("sentry", "https://mcp.sentry.dev/mcp", &[]), target: Target::Codex },
        ];

        let mut overrides = BTreeMap::new();
        let key = |account: &Account, name: &str| (account.key(), name.to_string());
        overrides.insert(key(&personal, "linear"), Override { state: ChipState::NeedsSignIn, error: None });
        overrides.insert(key(&work, "linear"), Override { state: ChipState::NeedsSignIn, error: None });
        overrides.insert(
            key(&work, "notion"),
            Override { state: ChipState::Failed, error: Some("401 Unauthorized: the token expired".to_string()) },
        );
        overrides.insert(key(&work, "playwright"), Override { state: ChipState::Disabled, error: None });

        let mut outside = BTreeMap::new();
        outside.insert(
            personal.key(),
            vec![
                report("happiergym-db", Transport::Command, Scope::Project, "node scripts/db-mcp.mjs", 9),
                with_state(
                    report("plugin:engineering:atlassian", Transport::Url, Scope::Plugin, "https://mcp.atlassian.com/v2/mcp", 0),
                    ChipState::NeedsSignIn,
                ),
                report(
                    "plugin:engineering:datadog",
                    Transport::Url,
                    Scope::Plugin,
                    "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
                    18,
                ),
                report("plugin:engineering:notion", Transport::Url, Scope::Plugin, "https://mcp.notion.com/mcp", 14),
                report("claude.ai Gmail", Transport::Connector, Scope::ClaudeAi, "", 11),
                report("claude.ai Google Drive", Transport::Connector, Scope::ClaudeAi, "", 13),
                with_state(report("claude.ai Slack", Transport::Connector, Scope::ClaudeAi, "", 0), ChipState::NeedsSignIn),
                report("argent", Transport::Command, Scope::BuiltIn, "argent mcp", 31),
            ],
        );
        outside.insert(
            codex.key(),
            vec![
                report("argent", Transport::Command, Scope::BuiltIn, "argent mcp", 31),
                ServerReport {
                    disabled_by_provider: true,
                    ..with_state(
                        report("happiergym-db", Transport::Command, Scope::Project, "node scripts/db-mcp.mjs", 0),
                        ChipState::Disabled,
                    )
                },
            ],
        );

        Self { accounts, stored, overrides, outside, fail_remove: None, problems: BTreeMap::new() }
    }

    pub fn accounts(&self) -> Vec<Account> {
        self.accounts.clone()
    }

    pub fn set_problem(&mut self, account: &Account, problem: Option<&str>) {
        match problem {
            Some(text) => self.problems.insert(account.key(), text.to_string()),
            None => self.problems.remove(&account.key()),
        };
    }

    fn lives_in(target: Target, account: &Account) -> Option<Scope> {
        match target {
            Target::Everywhere => Some(Scope::Everywhere),
            Target::Claude if account.provider == Provider::Claude => Some(Scope::User),
            Target::Codex if account.provider == Provider::Codex => Some(Scope::User),
            _ => None,
        }
    }

    /// One account's check (`mcp:check`).
    pub fn check(&self, account: &Account) -> AccountCheck {
        if let Some(problem) = self.problems.get(&account.key()) {
            return AccountCheck { account: account.clone(), problem: Some(problem.clone()), servers: Vec::new() };
        }
        let mut servers = Vec::new();
        for stored in &self.stored {
            let Some(scope) = Self::lives_in(stored.target, account) else { continue };
            let (transport, detail) = match &stored.def {
                Definition::Url { url, .. } => (Transport::Url, url.clone()),
                Definition::Stdio { command, args, .. } => {
                    (Transport::Command, std::iter::once(command.clone()).chain(args.iter().cloned()).collect::<Vec<_>>().join(" "))
                }
            };
            let mut server = report(stored.def.name(), transport, scope, &detail, tools_for(stored.def.name()));
            if let Some(over) = self.overrides.get(&(account.key(), stored.def.name().to_string())) {
                server.state = over.state;
                server.error.clone_from(&over.error);
                if over.state != ChipState::Connected {
                    server.tools = 0;
                }
            }
            servers.push(server);
        }
        if let Some(outside) = self.outside.get(&account.key()) {
            for server in outside {
                let mut server = server.clone();
                if let Some(over) = self.overrides.get(&(account.key(), server.name.clone()))
                    && !server.disabled_by_provider
                {
                    server.state = over.state;
                    server.tools = if over.state == ChipState::Connected { tools_for(&server.name) } else { 0 };
                }
                servers.push(server);
            }
        }
        AccountCheck { account: account.clone(), problem: None, servers }
    }

    /// The switch of one account's server (`mcp:toggle`).
    pub fn toggle(&mut self, account: &Account, name: &str, on: bool) {
        let key = (account.key(), name.to_string());
        if on {
            let was_unchecked = self.overrides.get(&key).is_some_and(|over| over.state == ChipState::Disabled);
            if was_unchecked {
                self.overrides.remove(&key);
            }
        } else {
            self.overrides.insert(key, Override { state: ChipState::Disabled, error: None });
        }
    }

    /// A finished browser sign-in: every account that needed one for the server now connects.
    pub fn finish_sign_in(&mut self, name: &str) {
        for account in self.accounts.clone() {
            let key = (account.key(), name.to_string());
            if self.overrides.get(&key).is_some_and(|over| over.state == ChipState::NeedsSignIn) {
                self.overrides.remove(&key);
            }
        }
        for (account_key, servers) in &mut self.outside {
            for server in servers.iter_mut().filter(|server| server.name == name && server.state == ChipState::NeedsSignIn) {
                server.state = ChipState::Connected;
                server.tools = tools_for(name);
                let _ = account_key;
            }
        }
    }

    /// `mcp:definition`: what the sheet edits. Secret-looking values come back as the mask.
    pub fn definition(&self, name: &str, target: Target) -> Option<Definition> {
        let stored = self.stored.iter().find(|stored| stored.def.name() == name && stored.target == target)?;
        Some(match &stored.def {
            Definition::Url { name, kind, url, headers } => Definition::Url {
                name: name.clone(),
                kind: *kind,
                url: url.clone(),
                headers: headers.iter().map(|(k, v)| (k.clone(), if is_secret(k) { SECRET_MASK.to_string() } else { v.clone() })).collect(),
            },
            Definition::Stdio { name, command, args, env } => Definition::Stdio {
                name: name.clone(),
                command: command.clone(),
                args: args.clone(),
                env: env.iter().map(|(k, v)| (k.clone(), if is_secret(k) { SECRET_MASK.to_string() } else { v.clone() })).collect(),
            },
        })
    }

    /// The secret a stored server really holds (what the mask stands for).
    pub fn stored_secret(&self, name: &str, target: Target, key: &str) -> Option<String> {
        let stored = self.stored.iter().find(|stored| stored.def.name() == name && stored.target == target)?;
        let pairs = match &stored.def {
            Definition::Url { headers, .. } => headers,
            Definition::Stdio { env, .. } => env,
        };
        pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    /// `mcp:remove`: the server leaves one config.
    pub fn remove(&mut self, name: &str, target: Target) -> Result<(), String> {
        if self.fail_remove == Some(target) {
            return Err("Permission denied.".to_string());
        }
        self.stored.retain(|stored| !(stored.def.name() == name && stored.target == target));
        Ok(())
    }

    /// `mcp:save`: a new server, or an edit (`previous` names the server and config being replaced). A masked
    /// value that comes back keeps the stored one.
    pub fn save(&mut self, def: Definition, target: Target, previous: Option<(&str, Target)>) -> Result<(), String> {
        let taken = |host: &Host| host.stored.iter().any(|stored| stored.def.name() == def.name() && stored.target == target);
        if let Some((old_name, old_target)) = previous {
            if (old_name, old_target) != (def.name(), target) && taken(self) {
                return Err(format!("{} already exists in {}.", def.name(), target.label()));
            }
        } else if taken(self) {
            return Err(format!("{} already exists in {}.", def.name(), target.label()));
        }
        let mut def = def;
        if let Some((old_name, old_target)) = previous {
            let keep = |pairs: &mut Vec<(String, String)>, host: &Host| {
                for (key, value) in pairs.iter_mut().filter(|(_, value)| value == SECRET_MASK) {
                    if let Some(real) = host.stored_secret(old_name, old_target, key) {
                        *value = real;
                    }
                }
            };
            match &mut def {
                Definition::Url { headers, .. } => keep(headers, self),
                Definition::Stdio { env, .. } => keep(env, self),
            }
            self.stored.retain(|stored| !(stored.def.name() == old_name && stored.target == old_target));
            self.overrides.retain(|(_, name), _| name != old_name || old_name == def.name());
        }
        let is_new_url = previous.is_none() && matches!(&def, Definition::Url { headers, .. } if headers.is_empty());
        let name = def.name().to_string();
        self.stored.push(Stored { def, target });
        if is_new_url {
            for account in self.accounts.clone() {
                if Self::lives_in(target, &account).is_some() && account.provider == Provider::Claude {
                    self.overrides.insert((account.key(), name.clone()), Override { state: ChipState::NeedsSignIn, error: None });
                }
            }
        }
        Ok(())
    }

    /// The names the page can edit, for tests.
    pub fn stored_names(&self) -> Vec<String> {
        self.stored.iter().map(|stored| stored.def.name().to_string()).collect()
    }

    pub fn edit_target_of(&self, row: &super::logic::Row) -> Target {
        edit_target(row)
    }
}

fn is_secret(key: &str) -> bool {
    let key = key.to_lowercase();
    ["authorization", "token", "secret", "password", "api-key", "api_key", "apikey"].iter().any(|word| key.contains(word))
}
