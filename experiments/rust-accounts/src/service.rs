//! Metadata-only service. Observations are trusted owner inputs, never renderer claims.
use crate::{store::Writer, AccountError, AccountSandbox, Accounts, Result, Selection};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;
const CLOSED: &str = "Account manager is closing.";
const STALE: &str =
    "Account readiness is stale or belongs to another account. Refresh and try again.";
const NAME: &str = "Enter an account name of 1 to 80 characters.";
const KIRO:&str="Kiro uses the account kiro-cli is signed in to. Run `kiro-cli login` in a terminal to sign in or switch, then refresh.";
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityState {
    Unknown,
    Ready,
    SignedOut,
    Error,
    SigningIn,
}
impl IdentityState {
    fn text(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Ready => "ready",
            Self::SignedOut => "signed-out",
            Self::Error => "error",
            Self::SigningIn => "signing-in",
        }
    }
}
#[derive(Debug, Clone, Copy)]
pub enum Availability {
    Installed,
    Missing,
}
/// A single-use trusted observation. It cannot retain the writer lock, be cloned or be constructed externally.
pub struct Readiness {
    owner: Uuid,
    generation: u64,
    provider: String,
    id: String,
    state: IdentityState,
    sequence: u64,
}
impl std::fmt::Debug for Readiness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Readiness(<scoped observation>)")
    }
}
/// Issued before asynchronous inspection; a late result cannot update a newer owner/generation.
pub struct Observation {
    owner: Uuid,
    generation: u64,
    provider: String,
    id: String,
    sequence: u64,
}
impl std::fmt::Debug for Observation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Observation(<scoped request>)")
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountEvent {
    pub owner: Uuid,
    pub provider: String,
    pub generation: u64,
}
/// This is explicitly not Node's completed `accounts:add` response. Profile setup and login are pending.
#[derive(Debug, Clone)]
pub struct PendingCreation {
    pub account: Value,
    pub snapshot: Value,
}
impl PendingCreation {
    pub fn pending(&self) -> [&'static str; 2] {
        ["prepare-private-profile", "login"]
    }
}
pub struct AccountService {
    writer: Option<Writer>,
    accounts: Accounts,
    owner: Uuid,
    generation: u64,
    identities: BTreeMap<(String, String), IdentityState>,
    observations: BTreeMap<(String, String), u64>,
    sequence: u64,
    events: Vec<AccountEvent>,
}
impl std::fmt::Debug for AccountService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccountService(<isolated metadata>)")
    }
}
impl AccountSandbox {
    pub fn open(&self) -> Result<AccountService> {
        let writer = self.acquire()?;
        let accounts = Accounts::parse(writer.body()?)?;
        Ok(AccountService {
            writer: Some(writer),
            accounts,
            owner: Uuid::new_v4(),
            generation: 0,
            identities: BTreeMap::new(),
            observations: BTreeMap::new(),
            sequence: 0,
            events: Vec::new(),
        })
    }
}
impl AccountService {
    pub fn accounts(&self) -> &Accounts {
        &self.accounts
    }
    pub fn pin(&self, scope: Option<&str>) -> Result<Selection> {
        if let Some(scope) = scope {
            crate::valid_scope(scope)?;
        }
        self.accounts.pin(scope)
    }
    pub fn owner_id(&self) -> Uuid {
        self.owner
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn snapshot(&self) -> Value {
        self.decorate(self.accounts.snapshot())
    }
    pub fn scope_snapshot(&self, scope: &str) -> Result<Value> {
        self.accounts
            .scope_snapshot(scope)
            .map(|s| self.decorate(s))
    }
    fn decorate(&self, mut snapshot: Value) -> Value {
        if let Some(providers) = snapshot["providers"].as_array_mut() {
            for group in providers {
                if let Some(accounts) = group["accounts"].as_array_mut() {
                    for account in accounts {
                        if account["missing"] == true {
                            continue;
                        }
                        let key = (
                            account["provider"].as_str().unwrap_or("").to_owned(),
                            account["id"].as_str().unwrap_or("").to_owned(),
                        );
                        if let Some(state) = self.identities.get(&key) {
                            account["state"] = json!(state.text());
                            if *state == IdentityState::SigningIn {
                                account["message"] =
                                    json!("Finish signing in in the browser on your computer.");
                            }
                        }
                    }
                }
            }
        }
        snapshot
    }
    fn active(&self) -> Result<()> {
        self.writer.as_ref().ok_or(AccountError(CLOSED))?.verify()
    }
    /// Owner-only callback after observing this exact account. Never expose to a renderer or tool.
    /// Every metadata commit or close invalidates outstanding observations, including unrelated ones.
    pub fn begin_observation(&mut self, provider: &str, id: &str) -> Result<Observation> {
        self.active()?;
        self.accounts.account(provider, id)?;
        self.sequence += 1;
        self.observations
            .insert((provider.into(), id.into()), self.sequence);
        Ok(Observation {
            owner: self.owner,
            generation: self.generation,
            provider: provider.into(),
            id: id.into(),
            sequence: self.sequence,
        })
    }
    pub fn observed(&mut self, request: Observation, state: IdentityState) -> Result<Readiness> {
        self.active()?;
        let key = (request.provider.clone(), request.id.clone());
        if request.owner != self.owner
            || request.generation != self.generation
            || self.observations.get(&key) != Some(&request.sequence)
        {
            return Err(AccountError(STALE));
        }
        self.accounts.account(&request.provider, &request.id)?;
        self.identities.insert(key, state);
        Ok(Readiness {
            owner: self.owner,
            generation: self.generation,
            provider: request.provider,
            id: request.id,
            state,
            sequence: request.sequence,
        })
    }
    fn ready(&self, provider: &str, id: &str, proof: &Readiness) -> Result<()> {
        if proof.owner != self.owner
            || proof.generation != self.generation
            || proof.provider != provider
            || proof.id != id
            || self.observations.get(&(provider.into(), id.into())) != Some(&proof.sequence)
            || self.identities.get(&(provider.into(), id.into())) != Some(&proof.state)
        {
            return Err(AccountError(STALE));
        }
        match proof.state {
            IdentityState::Ready => Ok(()),
            IdentityState::SigningIn => {
                Err(AccountError("Finish signing in before using this account."))
            }
            _ => Err(AccountError(
                "Sign in to this account, then refresh before using it.",
            )),
        }
    }
    fn persist(&mut self, next: Value, changed: Option<&str>) -> Result<()> {
        self.active()?;
        let next = Accounts::from_value(&next)?;
        let bytes =
            serde_json::to_vec(next.saved()).map_err(|_| AccountError(crate::READ_ERROR))?;
        self.writer
            .as_mut()
            .ok_or(AccountError(CLOSED))?
            .persist(bytes)?;
        self.accounts = next;
        self.generation += 1;
        if let Some(provider) = changed {
            self.events.push(AccountEvent {
                owner: self.owner,
                provider: provider.into(),
                generation: self.generation,
            });
        }
        Ok(())
    }
    /// Metadata checkpoint only. Real `add` also prepares profile/config/history and starts login.
    /// `availability` is trusted owner input; this service never discovers or launches a CLI.
    pub fn create(
        &mut self,
        provider: &str,
        label: &str,
        availability: Availability,
    ) -> Result<PendingCreation> {
        self.active()?;
        crate::provider_check(provider)?;
        if provider == "kiro" {
            return Err(AccountError(KIRO));
        }
        let label_trimmed = label.trim_matches(js_space);
        if label_trimmed.is_empty() || label.encode_utf16().count() > 80 {
            return Err(AccountError(NAME));
        }
        if self
            .identities
            .values()
            .any(|s| *s == IdentityState::SigningIn)
        {
            return Err(AccountError("Finish or cancel the current sign-in first."));
        }
        if self.accounts.saved()["accounts"]
            .as_array()
            .ok_or(AccountError(crate::READ_ERROR))?
            .len()
            >= 20
        {
            return Err(AccountError("You can save up to 20 accounts."));
        }
        if matches!(availability, Availability::Missing) {
            return Err(AccountError("Install the provider CLI first."));
        }
        let id = Uuid::new_v4().to_string();
        if self.accounts.saved()["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == id)
        {
            return Err(AccountError("Could not allocate a unique account ID."));
        }
        let account = json!({"id":id,"provider":provider,"label":label_trimmed});
        let mut next = self.accounts.saved().clone();
        next["accounts"]
            .as_array_mut()
            .unwrap()
            .push(account.clone());
        self.persist(next, None)?;
        Ok(PendingCreation {
            account,
            snapshot: self.snapshot(),
        })
    }
    pub fn select(&mut self, provider: &str, id: &str, proof: Readiness) -> Result<Value> {
        self.active()?;
        self.accounts.account(provider, id)?;
        self.ready(provider, id, &proof)?;
        let mut next = self.accounts.saved().clone();
        next["selected"][provider] = json!(id);
        self.persist(next, Some(provider))?;
        Ok(self.snapshot())
    }
    pub fn assign(
        &mut self,
        scope: &str,
        provider: &str,
        id: Option<&str>,
        proof: Option<Readiness>,
    ) -> Result<Value> {
        self.active()?;
        crate::valid_scope(scope)?;
        crate::provider_check(provider)?;
        if let Some(id) = id {
            self.accounts.account(provider, id)?;
            self.ready(provider, id, proof.as_ref().ok_or(AccountError(STALE))?)?;
        } else if proof.is_some() {
            return Err(AccountError(STALE));
        }
        let mut next = self.accounts.saved().clone();
        let mut choices = next["scopes"]
            .get(scope)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(id) = id {
            choices.insert(provider.into(), json!(id));
        } else {
            choices.shift_remove(provider);
        }
        if choices.is_empty() {
            next["scopes"].as_object_mut().unwrap().shift_remove(scope);
        } else {
            next["scopes"][scope] = Value::Object(choices);
        }
        self.persist(next, Some(provider))?;
        self.scope_snapshot(scope)
    }
    pub fn remove(&mut self, provider: &str, id: &str) -> Result<Value> {
        self.active()?;
        self.accounts.account(provider, id)?;
        if id == "default" {
            return Err(AccountError(
                "The connected CLI account cannot be removed here.",
            ));
        }
        let mut next = self.accounts.saved().clone();
        next["accounts"]
            .as_array_mut()
            .unwrap()
            .retain(|a| a["id"] != id);
        if next["selected"][provider] == id {
            next["selected"][provider] = json!("default");
        }
        // Scopes intentionally keep removed IDs, and no profile directory is touched.
        self.persist(next, Some(provider))?;
        self.identities.remove(&(provider.into(), id.into()));
        self.observations.remove(&(provider.into(), id.into()));
        Ok(self.snapshot())
    }
    pub fn take_events(&mut self) -> Vec<AccountEvent> {
        std::mem::take(&mut self.events)
    }
    /// Immediate metadata commits leave nothing to flush. Drop releases only this service's lock.
    pub fn close(&mut self) {
        self.writer.take();
        self.generation += 1;
    }
}
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
