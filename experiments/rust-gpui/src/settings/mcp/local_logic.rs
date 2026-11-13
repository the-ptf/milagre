//! The rules of `packages/shared/src/local-mcp.ts`: what a Milagre MCP connection may reach, the draft the setup
//! form edits, and how a draft becomes a configuration and a connection reads back as a draft.

/// Which Projects a grant covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Paths {
    All,
    Some(Vec<String>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cap {
    Read,
    Create,
    Start,
    Write,
}

impl Cap {
    pub fn as_str(self) -> &'static str {
        match self {
            Cap::Read => "read",
            Cap::Create => "create",
            Cap::Start => "start",
            Cap::Write => "write",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectGrant {
    pub paths: Paths,
    pub caps: Vec<Cap>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DesignIds {
    All,
    Some(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesignGrant {
    pub chat_id: String,
    pub design_ids: DesignIds,
    pub caps: Vec<Cap>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Grants {
    pub projects: Option<ProjectGrant>,
    pub worktrees: Option<ProjectGrant>,
    pub chats: Option<ProjectGrant>,
    pub designs: Option<DesignGrant>,
}

impl Grants {
    fn project_scopes(&self) -> Vec<&ProjectGrant> {
        [&self.projects, &self.worktrees, &self.chats].into_iter().flatten().collect()
    }

    fn all_caps(&self) -> Vec<Cap> {
        let mut caps: Vec<Cap> = self.project_scopes().iter().flat_map(|grant| grant.caps.clone()).collect();
        if let Some(designs) = &self.designs {
            caps.extend(designs.caps.iter().copied());
        }
        caps
    }

    fn writable(&self) -> bool {
        self.all_caps().iter().any(|cap| *cap != Cap::Read)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Configuration {
    pub label: String,
    pub grants: Grants,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Connection {
    pub id: String,
    pub config: Configuration,
    pub revision: u32,
    pub revoked_at: Option<String>,
    pub client_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Credential {
    pub connection: Connection,
    pub url: String,
    pub token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientState {
    Configured,
    Missing,
    Off,
    Error,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Client {
    pub id: String,
    pub label: String,
    pub config_path: String,
    pub enabled: bool,
    pub state: ClientState,
    pub connection: Option<Connection>,
    pub problem: Option<String>,
}

/// The configuration an MCP client reads (`localMcpClientConfig`).
pub fn client_config(credential: &Credential) -> String {
    format!(
        "{{\n  \"mcpServers\": {{\n    \"milagre\": {{\n      \"url\": \"{}\",\n      \"headers\": {{\n        \"Authorization\": \"Bearer {}\"\n      }}\n    }}\n  }}\n}}",
        credential.url, credential.token
    )
}

fn paths_text(paths: &Paths) -> String {
    match paths {
        Paths::All => "all Projects".to_string(),
        Paths::Some(list) => list.join(", "),
    }
}

/// One line: `projects: read (all Projects); chats: read, create, start (/a, /b)` (`localMcpDescription`).
pub fn description(connection: &Connection) -> String {
    let grants = &connection.config.grants;
    let mut parts = Vec::new();
    let caps = |caps: &[Cap]| caps.iter().map(|cap| cap.as_str()).collect::<Vec<_>>().join(", ");
    for (group, grant) in [("projects", &grants.projects), ("worktrees", &grants.worktrees), ("chats", &grants.chats)] {
        if let Some(grant) = grant {
            parts.push(format!("{group}: {} ({})", caps(&grant.caps), paths_text(&grant.paths)));
        }
    }
    if let Some(designs) = &grants.designs {
        let ids = match &designs.design_ids {
            DesignIds::All => "all designs".to_string(),
            DesignIds::Some(list) => list.join(", "),
        };
        parts.push(format!("designs: {} ({}; {ids})", caps(&designs.caps), designs.chat_id));
    }
    parts.join("; ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftKind {
    Projects,
    AllProjects,
    Designs,
}

impl DraftKind {
    pub const ALL: [DraftKind; 3] = [DraftKind::Projects, DraftKind::AllProjects, DraftKind::Designs];

    pub fn id(self) -> &'static str {
        match self {
            DraftKind::Projects => "projects",
            DraftKind::AllProjects => "all-projects",
            DraftKind::Designs => "designs",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            DraftKind::Projects => "Projects",
            DraftKind::AllProjects => "All Projects",
            DraftKind::Designs => "Designs only",
        }
    }

    pub fn from_id(id: &str) -> Option<DraftKind> {
        DraftKind::ALL.into_iter().find(|kind| kind.id() == id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub label: String,
    pub kind: DraftKind,
    pub project_paths: Vec<String>,
    pub chat_id: String,
    pub design_ids: String,
    pub write: bool,
    /// Set for a connection whose Project grants differ per group: kept as they are until the scope is touched.
    pub base_grants: Option<Grants>,
}

impl Default for Draft {
    fn default() -> Self {
        Self {
            label: String::new(),
            kind: DraftKind::Projects,
            project_paths: Vec::new(),
            chat_id: String::new(),
            design_ids: "*".to_string(),
            write: false,
            base_grants: None,
        }
    }
}

impl Draft {
    pub fn set_kind(&mut self, kind: DraftKind) {
        self.base_grants = None;
        self.kind = kind;
    }

    pub fn toggle_project(&mut self, path: &str) {
        self.base_grants = None;
        if let Some(ix) = self.project_paths.iter().position(|p| p == path) {
            self.project_paths.remove(ix);
        } else {
            self.project_paths.push(path.to_string());
        }
    }

    pub fn valid(&self) -> bool {
        if self.label.trim().is_empty() {
            return false;
        }
        if self.kind == DraftKind::Designs {
            return !self.chat_id.trim().is_empty();
        }
        if self.kind == DraftKind::AllProjects {
            return true;
        }
        if let Some(base) = &self.base_grants {
            return base.project_scopes().iter().any(|grant| match &grant.paths {
                Paths::All => true,
                Paths::Some(list) => !list.is_empty(),
            });
        }
        !self.project_paths.is_empty()
    }

    /// The configuration this draft saves (`localMcpConfiguration`).
    pub fn configuration(&self) -> Configuration {
        let read_create = |write: bool| if write { vec![Cap::Read, Cap::Create] } else { vec![Cap::Read] };
        let chat_caps = |write: bool| if write { vec![Cap::Read, Cap::Create, Cap::Start] } else { vec![Cap::Read] };
        if let (Some(base), false) = (&self.base_grants, self.kind == DraftKind::Designs) {
            return Configuration {
                label: self.label.clone(),
                grants: Grants {
                    projects: base.projects.as_ref().map(|grant| ProjectGrant { paths: grant.paths.clone(), caps: vec![Cap::Read] }),
                    worktrees: base
                        .worktrees
                        .as_ref()
                        .map(|grant| ProjectGrant { paths: grant.paths.clone(), caps: read_create(self.write) }),
                    chats: base.chats.as_ref().map(|grant| ProjectGrant { paths: grant.paths.clone(), caps: chat_caps(self.write) }),
                    designs: None,
                },
                expires_at: None,
            };
        }
        let paths = if self.kind == DraftKind::AllProjects { Paths::All } else { Paths::Some(self.project_paths.clone()) };
        let grants = if self.kind == DraftKind::Designs {
            let ids = self.design_ids.trim();
            Grants {
                designs: Some(DesignGrant {
                    chat_id: self.chat_id.trim().to_string(),
                    design_ids: if ids == "*" {
                        DesignIds::All
                    } else {
                        DesignIds::Some(ids.split(',').map(str::trim).filter(|id| !id.is_empty()).map(str::to_string).collect())
                    },
                    caps: if self.write { vec![Cap::Read, Cap::Write] } else { vec![Cap::Read] },
                }),
                ..Grants::default()
            }
        } else {
            Grants {
                projects: Some(ProjectGrant { paths: paths.clone(), caps: vec![Cap::Read] }),
                worktrees: Some(ProjectGrant { paths: paths.clone(), caps: read_create(self.write) }),
                chats: Some(ProjectGrant { paths, caps: chat_caps(self.write) }),
                designs: None,
            }
        };
        Configuration { label: self.label.clone(), grants, expires_at: None }
    }

    /// A connection read back as the draft that would save it (`localMcpDraftFor`).
    pub fn for_configuration(config: &Configuration) -> Draft {
        let grants = &config.grants;
        let scopes = grants.project_scopes();
        let mixed = has_mixed_grants(grants);
        let all_projects = grants.designs.is_none() && !mixed && !scopes.is_empty() && scopes.iter().all(|grant| grant.paths == Paths::All);
        let mut project_paths: Vec<String> = Vec::new();
        for grant in &scopes {
            if let Paths::Some(list) = &grant.paths {
                for path in list {
                    if !project_paths.contains(path) {
                        project_paths.push(path.clone());
                    }
                }
            }
        }
        let designs = grants.designs.as_ref();
        Draft {
            label: config.label.clone(),
            kind: if designs.is_some() {
                DraftKind::Designs
            } else if all_projects {
                DraftKind::AllProjects
            } else {
                DraftKind::Projects
            },
            chat_id: designs.map(|d| d.chat_id.clone()).unwrap_or_default(),
            design_ids: match designs.map(|d| &d.design_ids) {
                Some(DesignIds::Some(list)) => list.join(", "),
                _ => "*".to_string(),
            },
            project_paths,
            write: grants.writable(),
            base_grants: mixed.then(|| grants.clone()),
        }
    }
}

fn has_mixed_grants(grants: &Grants) -> bool {
    if grants.designs.is_some() {
        return false;
    }
    let groups = [&grants.projects, &grants.worktrees, &grants.chats];
    if groups.iter().any(|group| group.is_none()) {
        return groups.iter().any(|group| group.is_some());
    }
    let first = grants.projects.as_ref().map(|grant| &grant.paths);
    groups.iter().any(|group| group.as_ref().map(|grant| &grant.paths) != first)
}

/// The same connection restricted to read (`localMcpReadOnly`).
pub fn read_only(connection: &Connection) -> Configuration {
    let keep = |grant: &Option<ProjectGrant>| {
        grant
            .as_ref()
            .filter(|grant| grant.caps.contains(&Cap::Read))
            .map(|grant| ProjectGrant { paths: grant.paths.clone(), caps: vec![Cap::Read] })
    };
    let grants = &connection.config.grants;
    Configuration {
        label: connection.config.label.clone(),
        grants: Grants {
            projects: keep(&grants.projects),
            worktrees: keep(&grants.worktrees),
            chats: keep(&grants.chats),
            designs: grants.designs.as_ref().filter(|grant| grant.caps.contains(&Cap::Read)).map(|grant| DesignGrant {
                chat_id: grant.chat_id.clone(),
                design_ids: grant.design_ids.clone(),
                caps: vec![Cap::Read],
            }),
        },
        expires_at: connection.config.expires_at.clone(),
    }
}

impl Connection {
    pub fn writable(&self) -> bool {
        self.config.grants.writable()
    }

    /// Not revoked and not past its expiry (`now` and `expires_at` are ISO timestamps, which sort as text).
    pub fn active(&self, now: &str) -> bool {
        self.revoked_at.is_none() && !self.config.expires_at.as_deref().is_some_and(|expires| expires <= now)
    }
}

/// The line under a client: its problem, or its scope and access (`localMcpClientDetail`).
pub fn client_detail(client: &Client) -> String {
    if let Some(problem) = &client.problem {
        return problem.clone();
    }
    if client.state == ClientState::Missing {
        return "Configuration missing. Open setup to reconnect.".to_string();
    }
    let (true, Some(connection)) = (client.enabled, &client.connection) else { return String::new() };
    let draft = Draft::for_configuration(&connection.config);
    let scope = match draft.kind {
        DraftKind::Designs => format!("Designs in {}", draft.chat_id),
        DraftKind::AllProjects => "All Projects".to_string(),
        DraftKind::Projects if draft.base_grants.is_some() => "Custom Project scope".to_string(),
        DraftKind::Projects => {
            let n = draft.project_paths.len();
            format!("{n} {}", if n == 1 { "Project" } else { "Projects" })
        }
    };
    format!("{scope} · {}", if draft.write { "Read and write" } else { "Read only" })
}
