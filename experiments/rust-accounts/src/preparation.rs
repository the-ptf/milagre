//! Synthetic profile preparation. No source path, HOME discovery, credential read or process.
use crate::{config, store::Writer, AccountError, Result};

/// Text from a synthetic fixture, not paths to existing profiles. Debug never prints contents.
/// Set skill flags only to create empty synthetic Gemini skill folders.
#[derive(Default, Clone)]
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
        if !self.profile_absent(&["home"])? {
            return Err(AccountError(
                "Synthetic source home already exists and cannot be adopted.",
            ));
        }
        // Size validation precedes filesystem changes. Provider-specific parsing happens at preparation.
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
        self.profile_directory(&["home", ".codex"])?;
        self.profile_directory(&["home", ".claude"])?;
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
                self.profile_write(parts, name, text)?;
            }
        }
        for (yes, part) in [
            (sources.gemini_config_skills, "config"),
            (sources.gemini_cli_skills, "antigravity-cli"),
        ] {
            if yes {
                self.profile_directory(&["home", ".gemini", part, "skills"])?;
            }
        }
        self.mark_prepared(SOURCES)
    }
    pub(crate) fn prepare_profile(&self, provider: &str, id: &str) -> Result<()> {
        if !self.prepared(SOURCES)? {
            return Err(AccountError(MISSING));
        }
        let key = format!("profile:{provider}:{id}");
        if self.prepared(&key)? {
            return Ok(());
        }
        let target = ["accounts", id];
        if !self.profile_absent(&target)? {
            return Err(AccountError(EXISTS));
        }
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
                let config = if codex {
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
                self.profile_directory(&target)?;
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
                    let original = [source[0], source[1], folder];
                    self.profile_directory(&original)?;
                    self.profile_link(&["accounts", id, folder], &original)?;
                }
                if let Some(text) = config {
                    self.profile_write(&target, filename, &text)?;
                }
                if let Some(text) = instructions {
                    self.profile_write(&target, instructions_name, &text)?;
                }
                // Node's next login/environment call inherits MCP before spawning. No login here.
                let source_mcp = if codex {
                    source_config
                } else {
                    self.profile_read(&["home"], ".claude.json")?
                };
                self.refresh_mcp(provider, id, source_mcp.as_deref())?;
            }
            "antigravity" => {
                self.prepare_default_antigravity()?;
                self.antigravity_folders(id, true)?;
            }
            _ => {
                return Err(AccountError(
                    "This provider has no isolated profile preparation.",
                ))
            }
        }
        self.mark_prepared(&key)
    }
    pub(crate) fn prepare_default_antigravity(&self) -> Result<()> {
        if !self.prepared(SOURCES)? {
            return Err(AccountError(MISSING));
        }
        let key = "profile:antigravity:default";
        if self.prepared(key)? {
            return Ok(());
        }
        if !self.profile_absent(&["accounts", "antigravity-default"])? {
            return Err(AccountError(EXISTS));
        }
        self.antigravity_folders("antigravity-default", false)?;
        self.mark_prepared(key)
    }
    fn antigravity_folders(&self, id: &str, history: bool) -> Result<()> {
        self.profile_directory(&["accounts", id, "antigravity-acp"])?;
        for part in ["config", "antigravity-cli"] {
            let source = ["home", ".gemini", part, "skills"];
            if !self.profile_absent(&source)? {
                self.profile_link(&["accounts", id, part, "skills"], &source)?;
            }
        }
        if history {
            for folder in ["conversations", "brain"] {
                let source = ["accounts", "antigravity-default", "antigravity-acp", folder];
                self.profile_directory(&source)?;
                self.profile_link(&["accounts", id, "antigravity-acp", folder], &source)?;
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
