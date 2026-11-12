# App fixture content owner

Only `app_fixture::start()` creates the seeded content described here. It uses the generated Project and the same `SharedContent` / `ContentOwner` used by the Claude content fixture. The dedicated [configured Chat runtime](CHAT-RUNTIME.md#retained-configured-content) reuses that owner with durable storage and owner-approved Chat admission, without this initializer or seeded content. There is no second `ArtifactService`, alternate content writer, Node child, caller-supplied path or public tool-dispatch endpoint.

## Saved fixture data

After `host.open_project` succeeds and before the socket binds, a private startup initializer calls the owner's real `Dispatcher` for `artifact_show` and `design_show`. It checks both tool results and reads both saved records back through the renderer interface. Any failure rejects startup. Chat state and its empty message seed remain unchanged; an ordinary scripted send can make Chat 1 visible in the production sidebar.

| Chat                   | Record                        | Initial value                                                                                            |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| generated Project `#1` | HTML `fixture-report`         | Title `Rust fixture report`, heading `Rust fixture artifact`                                             |
| generated Project `#1` | Design `fixture-screen`       | Title `Rust fixture screen`, group `Fixture`, 390 by 260; text node `heading` says `Rust fixture design` |
| generated Project `#1` | HTML asset `fixture-note.txt` | UTF-8 bytes `Rust fixture asset\n`                                                                       |
| generated Project `#2` | none                          | Empty catalog, retained as a separate admitted scope                                                     |

Both records start at version 1. The temporary source asset is created only inside the fresh Project, copied through the actual Artifact store, then removed. Subsequent reads use the saved store bytes. The Design has native generated HTML. No raster helper is attached: the tool result explicitly reports unavailable PNG feedback. This checkpoint claims no tool image rendering, transcript image persistence or live-agent creation.

## Authority and commands

The actor advertises `artifact:list`, `artifact:get`, `artifact:asset`, `artifact:comments` and `artifact:apply` only while it has the content owner. This app instance additionally advertises `designs:enabled:read` and `designs:enabled:save`. Both return `{enabled:true}`, matching Node's permanently enabled Designs and retired save switch. The original scripted, Claude and ACP actor method sets remain unchanged.

Every command requires the connection's existing Project view and live owner readiness. They are not global bootstrap reads. Reads never open or recover a Project. A forgotten Project or failed root/ownership check revokes content access; restoring filesystem paths alone does not reopen it. An explicit successful open permits new grants, while a retained tool grant from the previous generation stays revoked.

The resolver accepts only the generated Project's Chats 1 and 2. Foreign Projects and other Chat ids fail. The content store enforces its own exclusive writers, storage checks and immutable renderer scope. Graceful actor shutdown revokes content and drops its stores before private-profile cleanup. Retained tool grants cannot keep an active writer after shutdown.

## Checks and limits

`tests/app-content-compat.cjs`, run by `tests/app_bootstrap.rs`, uses the production Node clients against the app-fixture binary. Separate real Node Artifact and Design-kit stores compare catalogs, HTML/source records, font requests, comments, asset chunks and the native Design edit. The oracle's edit clock is matched to the saved native revision timestamp. Tests also cover stale versions, connection reopen, unchanged Chat state, foreign scopes, forget, root replacement, explicit reopen, normal daemon stop and profile/socket removal.

The Rust startup/lifetime test proves unopened initialization refuses before creating its source file, a second content owner is refused, a tool edit is visible through renderer reads, old grants never revive, and shutdown releases the stores while a revoked grant is still retained. Existing shared-content tests retain renderer/tool competing-write coverage.

There is no injected failure after the first record commits. Startup returns an error before binding on a later save/readback failure, but this checkpoint does not claim partial-initialization cleanup test evidence.

`artifact:delete` and `artifact:add-comments` remain unadvertised and refused. Reading existing comments is supported, but creating comments and deleting Designs are not claimed. This fixture retains its fixed two-Chat resolver; the configured runtime uses the separate trusted owner-admission seam documented above. Actual WebKit content rendering belongs to a separate native checkpoint; passing these daemon tests does not prove it. The installed application still uses the production Node owner.
