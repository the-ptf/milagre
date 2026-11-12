//! Isolated local protocol foundation. This crate does not own or write Milagre Projects.
//! A server binds either a new temporary directory created by [`IsolatedProfile`], or the socket of a data directory
//! whose Node-format `runtime.lock` the calling process already holds ([`DataDirEndpoint`]); this crate never takes
//! that lock and never decides which data directories an owner may claim.
//! No provider, Project store, mobile service or production startup is included.
#![cfg(unix)]

mod data_dir;
mod diagnostics;
mod pages;
mod profile;
mod protocol;
mod server;
pub mod state_patch;

pub use data_dir::{node_realpath, socket_path_for, DataDirEndpoint};
pub use diagnostics::{DisconnectDiagnostics, DisconnectReason};
pub use profile::{IsolatedProfile, ProfileLease};
pub use protocol::{RpcError, RpcResult, MAX_FRAME_BYTES, MAX_PENDING, VERSION};
pub use server::{
    ClientContext, ClientView, Config, EventSink, Handler, Publication, Server, ShutdownError,
};
