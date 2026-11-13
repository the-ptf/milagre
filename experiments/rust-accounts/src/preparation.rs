//! Synthetic profile preparation. No source path, HOME discovery, credential read or process.
use crate::{
    config,
    journal::{self, Step},
    store::Writer,
    AccountError, Result,
};

/// Text from a synthetic fixture, not paths to existing profiles. Debug never prints contents.
/// Set skill flags only to create empty synthetic Gemini skill folders.
#[derive(Default, Clone, serde::Serialize)]
pub struct SyntheticSources {
    pub codex_config: Option<String>,
    pub codex_instructions: Option<String>,
    pub claude_settings: Option<String>,
    pub claude_instructions: Option<String>,
    pub claude_mcp: Option<String>,
    pub gemini_config_skills: bool,
    pub gemini_cli_skills: bool,
}
impl std::fmt::Debug for SyntheticSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyntheticSources(<fixture contents redacted>)")
    }
}
/// File preparation is complete; this makes no claim about identity or login.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationStatus {
    Pending,
    Complete,
}
#[derive(Debug, Clone)]
pub struct RecoverableCreation {
    pub account: serde_json::Value,
    pub preparation: PreparationStatus,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpRefresh {
    pub config_changed: bool,
    pub record_changed: bool,
}
const SOURCES: &str = "synthetic-sources";
const MISSING: &str = "Seed synthetic account sources before preparing a profile.";
const EXISTS: &str =
    "An unprepared profile directory already exists. It cannot be adopted or overwritten.";
impl Writer {
    pub(crate) fn seed_sources(&self, sources: &SyntheticSources) -> Result<()> {
        if self.prepared(SOURCES)? {
            return Err(AccountError(
                "Synthetic account sources have already been seeded.",
            ));
        }
        let tag = blake3::hash(
            &serde_json::to_vec(sources).map_err(|_| AccountError(crate::READ_ERROR))?,
        )
        .to_hex()
        .to_string();
        if self.entry(SOURCES)?.is_some() {
            self.begin_plan(SOURCES, tag, vec![], None)?;
            return self.run_plan(SOURCES);
        }
        if !self.profile_absent(&["home"])? {
            return Err(AccountError(
                "Synthetic source home already exists and cannot be adopted.",
            ));
        }
        for text in [
            &sources.codex_config,
            &sources.codex_instructions,
            &sources.claude_settings,
            &sources.claude_instructions,
            &sources.claude_mcp,
        ]
        .into_iter()
        .flatten()
        {
            if text.len() > 4 * 1024 * 1024 {
                return Err(AccountError(crate::READ_ERROR));
            }
        }
        let mut steps = vec![];
        journal::directory(&mut steps, &["home", ".codex"]);
        journal::directory(&mut steps, &["home", ".claude"]);
        for (parts, name, text) in [
            (
                &["home", ".codex"][..],
                "config.toml",
                &sources.codex_config,
            ),
            (
                &["home", ".codex"][..],
                "AGENTS.md",
                &sources.codex_instructions,
            ),
            (
                &["home", ".claude"][..],
                "settings.json",
                &sources.claude_settings,
            ),
            (
                &["home", ".claude"][..],
                "CLAUDE.md",
                &sources.claude_instructions,
            ),
            (&["home"][..], ".claude.json", &sources.claude_mcp),
        ] {
            if let Some(text) = text {
                journal::file(&mut steps, parts, name, text.clone());
            }
        }
        for (present, part) in [
            (sources.gemini_config_skills, "config"),
            (sources.gemini_cli_skills, "antigravity-cli"),
        ] {
            if present {
                journal::directory(&mut steps, &["home", ".gemini", part, "skills"]);
            }
        }
        self.begin_plan(SOURCES, tag, steps, None)?;
        self.run_plan(SOURCES)
    }
    pub(crate) fn prepare_profile(&self, provider: &str, id: &str) -> Result<()> {
        self.prepare_profile_creation(provider, id, None)
    }
    pub(crate) fn prepare_profile_creation(
        &self,
        provider: &str,
        id: &str,
        creation: Option<&serde_json::Value>,
    ) -> Result<()> {
        if !self.prepared(SOURCES)? {
            return Err(AccountError(MISSING));
        }
        let key = format!("profile:{provider}:{id}");
        if let Some(entry) = self.entry(&key)? {
            if creation.is_some_and(|account| {
                entry
                    .creation
                    .as_ref()
                    .is_none_or(|c| c.account != *account)
            }) {
                return Err(AccountError(
                    "Preparation account differs from its saved creation plan.",
                ));
            }
            return self.run_plan(&key);
        }
        if !self.profile_absent(&["accounts", id])? {
            return Err(AccountError(EXISTS));
        }
        let mut steps = vec![];
        match provider {
            "codex" | "claude" => {
                let codex = provider == "codex";
                let source = ["home", if codex { ".codex" } else { ".claude" }];
                let filename = if codex {
                    "config.toml"
                } else {
                    "settings.json"
                };
                let source_config = self.profile_read(&source, filename)?;
                let mut target = if codex {
                    Some(config::codex_config(
                        source_config.as_deref().unwrap_or(""),
                        self.root_path()
                            .join("home/.codex")
                            .to_str()
                            .ok_or(AccountError(crate::READ_ERROR))?,
                    )?)
                } else {
                    source_config
                        .as_deref()
                        .map(config::claude_settings)
                        .transpose()?
                };
                let instructions_name = if codex { "AGENTS.md" } else { "CLAUDE.md" };
                let instructions = self.profile_read(&source, instructions_name)?;
                journal::directory(&mut steps, &["accounts", id]);
                let folders: &[&str] = if codex {
                    &[
                        "sessions",
                        "archived_sessions",
                        "skills",
                        "rules",
                        "plugins",
                        "generated_images",
                    ]
                } else {
                    &["projects", "skills", "commands", "agents", "plugins"]
                };
                for folder in folders {
                    journal::link(
                        &mut steps,
                        &["accounts", id, folder],
                        &[source[0], source[1], folder],
                    );
                }
                // Save the final text in the plan. Retry never rereads a changed source or copies twice.
                let inherited = if codex {
                    config::inherit_codex(source_config.as_deref(), target.as_deref(), None)?
                } else {
                    config::McpOutput::default()
                };
                if let Some(text) = inherited.target {
                    target = Some(text);
                }
                if let Some(text) = target {
                    journal::file(&mut steps, &["accounts", id], filename, text);
                }
                if let Some(text) = instructions {
                    journal::file(&mut steps, &["accounts", id], instructions_name, text);
                }
                if let Some(text) = inherited.record {
                    journal::file(
                        &mut steps,
                        &["accounts", id],
                        "milagre-inherited-mcp.json",
                        text,
                    );
                }
            }
            "antigravity" => {
                self.prepare_default_antigravity()?;
                self.antigravity_steps(&mut steps, id, true)?;
            }
            _ => {
                return Err(AccountError(
                    "This provider has no isolated profile preparation.",
                ))
            }
        }
        self.begin_plan(&key, key.clone(), steps, creation.cloned())?;
        self.run_plan(&key)
    }
    pub(crate) fn prepare_default_antigravity(&self) -> Result<()> {
        if !self.prepared(SOURCES)? {
            return Err(AccountError(MISSING));
        }
        let key = "profile:antigravity:default";
        if self.entry(key)?.is_some() {
            return self.run_plan(key);
        }
        if !self.profile_absent(&["accounts", "antigravity-default"])? {
            return Err(AccountError(EXISTS));
        }
        let mut steps = vec![];
        self.antigravity_steps(&mut steps, "antigravity-default", false)?;
        self.begin_plan(key, key.into(), steps, None)?;
        self.run_plan(key)
    }
    fn antigravity_steps(&self, steps: &mut Vec<Step>, id: &str, history: bool) -> Result<()> {
        journal::directory(steps, &["accounts", id, "antigravity-acp"]);
        for part in ["config", "antigravity-cli"] {
            let source = ["home", ".gemini", part, "skills"];
            if !self.profile_absent(&source)? {
                journal::link(steps, &["accounts", id, part, "skills"], &source);
            }
        }
        if history {
            for folder in ["conversations", "brain"] {
                journal::link(
                    steps,
                    &["accounts", id, "antigravity-acp", folder],
                    &["accounts", "antigravity-default", "antigravity-acp", folder],
                );
            }
        }
        Ok(())
    }
    pub(crate) fn refresh_mcp(
        &self,
        provider: &str,
        id: &str,
        source: Option<&str>,
    ) -> Result<McpRefresh> {
        self.verify()?;
        if source.is_some_and(|text| text.len() > 4 * 1024 * 1024) {
            return Err(AccountError(crate::READ_ERROR));
        }
        let filename = match provider {
            "codex" => "config.toml",
            "claude" => ".claude.json",
            _ => {
                return Err(AccountError(
                    "This provider has no inherited MCP configuration.",
                ))
            }
        };
        let parts = ["accounts", id];
        let target = self.profile_read(&parts, filename)?;
        let previous = self.profile_read(&parts, "milagre-inherited-mcp.json")?;
        let output = if provider == "codex" {
            config::inherit_codex(source, target.as_deref(), previous.as_deref())?
        } else {
            config::inherit_claude(source, target.as_deref(), previous.as_deref())?
        };
        let report = McpRefresh {
            config_changed: output.target.is_some(),
            record_changed: output
                .record
                .as_deref()
                .is_some_and(|text| Some(text) != previous.as_deref()),
        };
        if let Some(text) = output.target {
            self.profile_write(&parts, filename, &text)?;
        }
        if let Some(text) = output.record {
            self.profile_write(&parts, "milagre-inherited-mcp.json", &text)?;
        }
        Ok(report)
    }
}
