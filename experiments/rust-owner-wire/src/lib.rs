//! Isolated local protocol foundation. This crate does not own or write Milagre Projects.
//! The only bindable profile is a new temporary directory created by [`IsolatedProfile`].
//! No provider, Project store, mobile service or production startup is included.
#![cfg(unix)]

mod pages;
mod profile;
mod protocol;
mod server;
pub mod state_patch;

pub use profile::IsolatedProfile;
pub use protocol::{RpcError, RpcResult, MAX_FRAME_BYTES, MAX_PENDING, VERSION};
pub use server::{ClientContext, ClientView, Config, EventSink, Handler, Publication, Server};
