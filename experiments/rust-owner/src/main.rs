//! `milagre-owner-store`: read-only audit and command reads over an explicit copy of Milagre Projects.
//!
//!   milagre-owner-store audit <copied-dir> [--allow-copied-lock] [--json]
//!   milagre-owner-store read <copied-project> state
//!   milagre-owner-store read <copied-project> chat:messages <chatId> [--before <id>] [--turns <n>] [--limit <n>]
//!   milagre-owner-store read <copied-project> chat:message <id>
//!   milagre-owner-store read <copied-project> chat:send-status <clientMessageId>
//!   milagre-owner-store read <copied-project> previews <chatId>...
//!
//! Output is JSON as the daemon writes it. Nothing is written, locked or started.

use std::path::PathBuf;
use std::process::ExitCode;

use milagre_owner_store::audit::{audit, AuditOptions};
use milagre_owner_store::jsjson;
use milagre_owner_store::ownership::{self, LockState, SystemProbe};
use milagre_owner_store::write::{ProjectStateWriter, SaveOptions};
use milagre_owner_store::{Isolation, OwnedProject, Policy};
use milagre_owner_store::{
    MessageRepository, PageOptions, ProjectReader, ProjectRepository, ProjectStore,
};
use serde_json::Value;

const USAGE: &str = "usage:
  milagre-owner-store audit <copied-dir> [--allow-copied-lock] [--json]
  milagre-owner-store read <copied-project> state | chat:messages <chatId> [--before <id>] [--turns <n>] [--limit <n>]
                                            | chat:message <id> | chat:send-status <clientMessageId> | previews <chatId>...
  [--allow-copied-lock] also applies to read.

Writes, only inside an isolated copy folder (a MILAGRE-ISOLATED-COPY marker; Milagre's folders and known Projects refused):
  milagre-owner-store prepare-copy <source-project> <new-empty-dir> [<name>]   copy a Project's .milagre (no lock) in
  milagre-owner-store save <isolated-dir> <name> <state.json> [--durable] [--unloaded <id,id>]
  milagre-owner-store rewrite <isolated-dir> <name>                            read as owner, save the same state back";

fn number(text: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(Value::is_number)
        .ok_or_else(|| format!("{text} is not a number"))
}

fn flag(args: &mut Vec<String>, name: &str) -> bool {
    let before = args.len();
    args.retain(|arg| arg != name);
    args.len() != before
}

fn option(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    let Some(index) = args.iter().position(|arg| arg == name) else {
        return Ok(None);
    };
    if index + 1 >= args.len() {
        return Err(format!("{name} needs a value"));
    }
    let value = args.remove(index + 1);
    args.remove(index);
    Ok(Some(value))
}

fn run() -> Result<(), String> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let allow_copied_lock = flag(&mut args, "--allow-copied-lock");
    let as_json = flag(&mut args, "--json");
    match args.first().map(String::as_str) {
        Some("audit") if args.len() == 2 => {
            let report = audit(
                &PathBuf::from(&args[1]),
                &AuditOptions {
                    allow_copied_lock,
                    ..Default::default()
                },
                &SystemProbe,
            )
            .map_err(|error| error.to_string())?;
            if as_json {
                println!("{}", jsjson::to_string(&report));
            } else {
                for project in report["projects"].as_array().into_iter().flatten() {
                    println!(
                        "{}  storage={} sessions={} rows={} lock={}",
                        project["project"].as_str().unwrap_or("?"),
                        project
                            .get("storage")
                            .and_then(Value::as_str)
                            .unwrap_or("unreadable"),
                        project.get("sessions").unwrap_or(&Value::Null),
                        project.get("rows").unwrap_or(&Value::Null),
                        project["lock"].as_str().unwrap_or("?")
                    );
                    for issue in project["issues"].as_array().into_iter().flatten() {
                        println!(
                            "  - {}: {}",
                            issue["kind"].as_str().unwrap_or("?"),
                            jsjson::to_string(&issue["detail"])
                        );
                    }
                }
                println!("{} issue(s); files unchanged.", report["issues"]);
            }
            Ok(())
        }
        Some("read") if args.len() >= 3 => {
            let project = PathBuf::from(&args[1]);
            for data_dir in milagre_owner_store::audit::default_data_dirs() {
                let real = std::fs::canonicalize(&project).unwrap_or(project.clone());
                if real.starts_with(std::fs::canonicalize(&data_dir).unwrap_or(data_dir.clone())) {
                    return Err(format!(
                        "{} is inside Milagre's data folder; read a copy.",
                        project.display()
                    ));
                }
            }
            if let LockState::Live { .. } =
                ownership::inspect(&ownership::project_lock(&project), &SystemProbe)
            {
                if !allow_copied_lock {
                    return Err(format!("{} has a live owner lock; read a copy (pass --allow-copied-lock if this is one).", project.display()));
                }
            }
            let reader = ProjectReader::new(ProjectStore::new(&project));
            let mut rest: Vec<String> = args[3..].to_vec();
            let output = match args[2].as_str() {
                "state" => jsjson::to_string(
                    &reader
                        .store()
                        .read_project_state()
                        .map_err(|e| e.to_string())?
                        .to_value(),
                ),
                "chat:messages" => {
                    let before = option(&mut rest, "--before")?
                        .map(|text| number(&text))
                        .transpose()?;
                    let turns = option(&mut rest, "--turns")?
                        .map(|text| number(&text))
                        .transpose()?;
                    let limit = option(&mut rest, "--limit")?
                        .map(|text| number(&text))
                        .transpose()?;
                    let chat = rest
                        .first()
                        .ok_or("chat:messages needs a chat id")?
                        .parse::<i64>()
                        .map_err(|e| e.to_string())?;
                    jsjson::to_string(
                        &reader
                            .chat_messages(
                                chat,
                                &PageOptions {
                                    before,
                                    turns,
                                    limit,
                                },
                            )
                            .map_err(|e| e.to_string())?,
                    )
                }
                "chat:message" => {
                    let id = number(rest.first().ok_or("chat:message needs an id")?)?;
                    jsjson::to_string(&reader.chat_message(&id).map_err(|e| e.to_string())?)
                }
                "chat:send-status" => jsjson::to_string(
                    &reader
                        .send_status(
                            rest.first()
                                .ok_or("chat:send-status needs a clientMessageId")?,
                        )
                        .map_err(|e| e.to_string())?,
                ),
                "previews" => {
                    let chats = rest
                        .iter()
                        .map(|text| text.parse::<i64>().map_err(|e| e.to_string()))
                        .collect::<Result<Vec<_>, _>>()?;
                    let previews = reader
                        .store()
                        .chats()
                        .read_chat_previews(&chats)
                        .map_err(|e| e.to_string())?;
                    format!(
                        "[{}]",
                        previews
                            .iter()
                            .map(|preview| preview.to_js_json())
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
                other => return Err(format!("unknown read: {other}\n{USAGE}")),
            };
            println!("{output}");
            Ok(())
        }
        Some("prepare-copy") if args.len() == 3 || args.len() == 4 => {
            let source = PathBuf::from(&args[1]);
            let name = args.get(3).cloned().unwrap_or_else(|| {
                source
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "project".into())
            });
            let isolation = Isolation::create(&PathBuf::from(&args[2]), &Policy::system())
                .map_err(|e| e.to_string())?;
            let copy = isolation
                .copy_project(&source, &name)
                .map_err(|e| e.to_string())?;
            println!("{}", copy.display());
            Ok(())
        }
        Some("save") if args.len() >= 4 => {
            let durable = flag(&mut args, "--durable");
            let unloaded = option(&mut args, "--unloaded")?
                .map(|list| {
                    list.split(',')
                        .map(|id| id.trim().parse::<i64>().map_err(|e| e.to_string()))
                        .collect::<Result<_, _>>()
                })
                .transpose()?
                .unwrap_or_default();
            let isolation = Isolation::open(&PathBuf::from(&args[1]), &Policy::system())
                .map_err(|e| e.to_string())?;
            let state = jsjson::parse_bytes(&std::fs::read(&args[3]).map_err(|e| e.to_string())?)?;
            let mut owner = OwnedProject::open(&isolation, std::path::Path::new(&args[2]), None)
                .map_err(|e| e.to_string())?;
            let options = SaveOptions {
                durable,
                unloaded,
                ..Default::default()
            };
            let report = owner
                .save_project_state(&state, &options)
                .map_err(|e| e.to_string());
            owner.release().map_err(|e| e.to_string())?;
            println!("{}", jsjson::to_string(&report?.to_value()));
            Ok(())
        }
        Some("rewrite") if args.len() == 3 => {
            let isolation = Isolation::open(&PathBuf::from(&args[1]), &Policy::system())
                .map_err(|e| e.to_string())?;
            let mut owner = OwnedProject::open(&isolation, std::path::Path::new(&args[2]), None)
                .map_err(|e| e.to_string())?;
            let report = owner
                .load()
                .and_then(|read| owner.save_project_state(&read.state, &SaveOptions::default()))
                .map_err(|e| e.to_string());
            owner.release().map_err(|e| e.to_string())?;
            println!("{}", jsjson::to_string(&report?.to_value()));
            Ok(())
        }
        _ => Err(USAGE.into()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
