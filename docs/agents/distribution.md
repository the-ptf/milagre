# Desktop packages

macOS is available through the [public Homebrew tap](https://github.com/the-ptf/homebrew-tap):

```sh
brew install --cask the-ptf/tap/milagre
```

The tap starts with the signed, notarized `v0.88.0` release for Apple Silicon and Intel. Its scheduled updater downloads both stable-release DMGs, checks their sizes and hashes, and commits the new cask. Uninstalling keeps saved Chats and settings.

| Platform | Architecture         | Installers         | Distribution                                                                       |
| -------- | -------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| macOS    | Apple Silicon, Intel | DMG, ZIP           | Homebrew tap and signed GitHub releases                                            |
| Windows  | x64                  | Per-user NSIS EXE  | WinGet manifest; public listing awaits a tested signed release                     |
| Linux    | x64                  | AppImage, DEB, RPM | Signed APT/RPM metadata and Cloudflare hosting workflow; first publication pending |

Windows ARM64, Linux ARM64, Chocolatey, Scoop, Flatpak and Snap remain outside this implementation. Git and a supported, logged-in agent CLI are still required. Electron bundles the host's Node runtime.

## Build and metadata

After `npm ci`, run on the target OS:

```sh
npm run package:mac:local -- --x64 --arm64 --config.extraMetadata.version=1.2.3
npm run package:win -- --config.extraMetadata.version=1.2.3
npm run package:linux -- --config.extraMetadata.version=1.2.3
```

Outputs live in `release/`: `Milagre-X.Y.Z-{arm64,x64}.{dmg,zip}`, `Milagre-Setup-X.Y.Z-x64.exe`, `Milagre-X.Y.Z-x86_64.AppImage`, `Milagre-X.Y.Z-amd64.deb`, and `Milagre-X.Y.Z-x86_64.rpm`. Linux's desktop file is `milagre.desktop`.

Generate signed Linux repositories before hashing the installers, because RPM signing changes its bytes:

```sh
npm run package:repositories -- --tag v1.2.3 --artifacts release \
  --output release/linux-repository --sign-rpm
node scripts/finalize-update-feeds.cjs --tag v1.2.3 --platform linux
npm run package:managers -- --tag v1.2.3 --platform all
node scripts/finalize-update-feeds.cjs --tag v1.2.3 --check
```

`package:repositories` requires `GNUPGHOME` outside the repo and `MILAGRE_LINUX_SIGNING_KEY` set to the full signing fingerprint. [Repository instructions](../../distribution/linux-repository/README.md) cover tooling and prior-release retention.

`package:managers` supports `macos`, `windows`, `linux`, a comma list such as `macos,linux` (also accepted by `finalize-update-feeds.cjs --platform`), or `all`, plus `--artifacts` and `--output`. It requires stable tags and nonempty regular installer files. It writes `homebrew/milagre.rb`, `winget/Milagre.Milagre.yaml`, and `SHA256SUMS` from the final installer bytes. For the old Intel naming convention, pass `--mac-intel-name Milagre-X.Y.Z.dmg`.

The cask follows the [Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook). WinGet uses Microsoft's [singleton manifest format](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest), user scope, and `/currentuser`. Its proposed identifier is `Milagre.Milagre`. Generating a manifest does not create a public WinGet listing.

## Validation and release

**Build package candidates** runs on every push to `main`, on dispatch, and on a PR once it carries the `preview:installers` label. Windows pipe, ACL and process tests and Linux repository signing run on every PR in CI's `native-tests` job without an installer. It builds on native macOS, Windows and Ubuntu runners. It installs the NSIS/DEB packages and runs the real desktop against temporary profiles, including saved Chats, shared-host updates, crash recovery, and ownership errors. Windows also runs real named-pipe, NTFS ACL and process tests. Candidate installers are unsigned/ad-hoc Actions artifacts, kept for 14 days.

The `release` job of CI cuts a candidate (a tag and a draft release) for every push to `main` once `javascript` and `native-tests` pass. The non-required `desktop-checks` job does not gate it. Drafts are invisible to installed apps.

**Publish** (`.github/workflows/publish.yml`) is the one release pipeline, for both channels. It picks a draft candidate (the `tag` input, or the newest draft newer than the published stable), builds every platform in parallel, then a single `publish` job collects the `installers-*` artifacts, checks the updater feeds with `finalize-update-feeds.cjs --check` and ships:

| Channel  | Trigger                                                    | Ships                                                                                                                                 | Needs                   |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `beta`   | weekdays 09:00 UTC, or dispatch                            | a `vX.Y.Z-beta.N` prerelease, never latest                                                                                            | macOS                   |
| `stable` | dispatch (`gh workflow run publish.yml -f channel=stable`) | the draft itself, marked latest, with Homebrew/WinGet metadata and `SHA256SUMS`; then **Deploy Linux package repository** runs for it | every platform it built |

macOS (`build-macos.yml`) and Linux always build. Windows builds only when the `RELEASE_WINDOWS` repository variable is `true`; enable it after configuring certificate credentials or Azure Artifact Signing and verifying a signed candidate. Windows requires Authenticode signing. See [Windows signing setup](windows-signing.md) for both options. A stable Linux build signs the RPM and the APT/RPM indexes and bundles `milagre-linux-repository.tar.gz`; a beta Linux build skips the package repository, which only ever carries stable releases. DMG notarization and RPM signing are followed by feed hash refreshes. **Deploy Linux package repository** can still be dispatched by hand to redeploy a tag.

## Beta channel

Installs set to Beta in Settings read `beta-mac.yml` (`beta-linux.yml`, `beta.yml` on Windows); Stable installs read the `latest*` feeds and never see a beta. A beta takes the draft candidate (`vX.Y.Z`), builds and signs it on the beta channel, and publishes `vX.Y.Z-beta.N`, where N counts up from that candidate's highest existing beta. It skips the run when a beta for the same commit already exists. Ship one by hand with `gh workflow run publish.yml`, optionally `-f tag=vX.Y.Z` to pick a specific draft. A platform whose beta build fails is left out of that beta with a warning.

A stable release carries only the `latest*` feeds. It rebuilds the newest beta's commit, so beta installs already run its code: they read their feed from the newest `vX.Y.Z-beta.N` release only (`resolveBetaFeed` in `apps/desktop/electron/release-channel.cjs`) and move on with the next beta, whose version is past the stable. `finalize-update-feeds.cjs` fails a stable that carries a `beta*` feed. Stables before v0.230 still carry a mirrored beta feed; beta installs older than that fix read it and get offered the stable once.

If `gh release create` succeeded but the asset upload failed, the next run sees a beta for that commit and skips it. Delete the broken prerelease and its tag with `gh release delete <betaTag> --cleanup-tag --yes`, then rerun the workflow. With no draft candidate, a scheduled run does nothing.

Required repository secrets:

| Purpose               | Secrets                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Apple signing         | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`             |
| Windows signing       | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                                                                 |
| Windows Azure signing | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (OIDC; replaces the certificate secrets) |
| Linux signing         | `LINUX_REPOSITORY_PRIVATE_KEY`, `LINUX_REPOSITORY_KEY_FINGERPRINT`                                     |
| Cloudflare deployment | `CLOUDFLARE_PACKAGES_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                                               |

Apple and Linux signing secrets and the Cloudflare account ID are configured. Windows signing and the dedicated Cloudflare deployment token still need setup. The existing local Cloudflare token stays in its private environment file; it is not copied into GitHub. Use a dedicated deployment token for the repository workflow.

Each stable release fetches the existing download/index mappings from `packages.milagre.cloud` before replacing current metadata. **Deploy Linux package repository** takes the public tag, verifies the bundle against the pinned fingerprint, downloads both public installers to check their hashes, and deploys `packages.milagre.cloud`. No private signing key enters the Worker. Install commands for that domain become usable after this deployment, not after a candidate build.

The repository key fingerprint is `0AC0E3D496374278E689EC0F6605D632D39BA587`. Its private key and revocation certificate are stored outside the checkout. Rotate the pinned fingerprint and public installation instructions together when rotating the key.

After a signed Windows EXE is public, validate the attached manifest with `winget validate`, test `winget install --manifest`, and submit it to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs). `winget install --id Milagre.Milagre` becomes available after Microsoft accepts the submission.

## In-app updates

Desktop checks at launch, every five minutes, when a window regains focus, and when the computer wakes. Automatic checks are throttled to one per minute; a manual check bypasses that throttle. Checks share one pending request and leave a downloading or downloaded update intact.

Downloads run in the background. A ready update opens a dismissible card with its release notes and an explicit **Install & restart** action. Dismissal keeps an update button available on every screen. Settings opens the same card before installation, which warns that restarting stops running agents. Installation saves and stops the shared host first; failed shutdown leaves the downloaded update available for retry. Normal quit never installs an update. These client checks do not change the publication schedules above.

## Runtime

Windows uses a local named pipe with mutual HMAC authentication. NTFS permissions restrict its token to the current Windows SID and SYSTEM. Unauthenticated peers receive no events or commands. Unix retains its private socket transport. Windows CLI shims run through their JavaScript entry points with literal arguments; Linux setup falls back to `sh`.

Run `npm test -- --unit` and `npm run build`. Real Windows behavior must pass its native runner before support is announced.

## Evidence from this implementation

Local macOS x64/arm64 DMG/ZIP builds and source/packaged desktop checks passed. Homebrew parsed and fetched the published cask, both public DMGs passed stapled-ticket validation, and the tap's release updater passed on GitHub Actions.

Linux x64 AppImage, DEB and RPM builds passed. Isolated Debian and Fedora containers installed the DEB and signed RPM and passed source/installed desktop checks without disabling Electron's sandbox. Real-tool repository tests verified GPG signatures, APT downloads through the Worker, DEB/RPM installation, and rejection of damaged package bytes. A production-sized signed repository generated a Worker bundle of about 28 KiB.

Windows manifest fixtures passed Microsoft's singleton schema. Native Windows checks passed the Codex protocol, named-pipe authentication, NTFS permissions, process cleanup, PowerShell 7 inheritance, fresh host startup, and real Git worktree identity. A real npm-installed Codex launcher and NSIS installation passed. Source and installed desktop checks preserved saved Chats, provider IDs, settings and drafts across shared clients, host restart and crash recovery; Project ownership errors and Retry also passed.

Full repository CI passed for the final runtime changes: [CI run](https://github.com/the-ptf/milagre-ade/actions/runs/37349549214). Native installer evidence is in the [candidate run](https://github.com/the-ptf/milagre-ade/actions/runs/37349549112); its unsigned artifacts are for testing, while public Windows/Linux publication still requires the credentials and release steps above.
