# App Store comparison and first implementation

Checked October 10, 2026. T3 Code and Paseo provide useful examples of shipped remote coding apps. Their store listings do not establish that Apple has approved every similar feature or data practice in Milagre.

## What the two apps do

| Area                 | T3 Code                                                                                                                                                 | Paseo                                                                                                                                      | Milagre decision                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy              | Public policy separates local/direct use from hosted Connect and identifies AI providers and service vendors. Mobile Settings has legal-document links. | Public policy separates the local app/daemon, relay, hosted Hub and website.                                                               | Describe each data path separately. Include AI context, paired-device caches, relay metadata, push previews, updates and connected tools.            |
| Relay choice         | Offers local/direct connections and hosted connectivity.                                                                                                | Desktop pairing explicitly asks to enable the encrypted relay, links to documentation and offers Not now.                                  | Keep pairing explicit and explain access before connection. Existing Milagre desktop device sharing is opt-in; add privacy/support links to pairing. |
| AI consent           | No dedicated first-send AI-sharing gate found in the public mobile source inspected. Provider OAuth consent is a separate flow.                         | No dedicated AI-sharing gate found in the public app source inspected. Relay consent is not AI consent.                                    | Add an explicit device-level AI disclosure and decision before sending or continuing work. Do not infer consent from provider sign-in.               |
| Store privacy labels | Listing declares data linked to the user, including content and other categories.                                                                       | Listing declares Data Not Collected.                                                                                                       | Determine labels from Milagre's actual collection and retention. Do not copy either label.                                                           |
| Review/release       | Public repository and listing establish a shipped mobile product, not a reusable reviewer-access recipe.                                                | Fastlane lane selects an eligible build and submits it for review; release docs distinguish upload success from review-submission success. | Keep metadata, review access and candidate verification as separate release requirements.                                                            |

Sources: [T3 privacy policy](https://t3.codes/privacy-policy), [T3 App Store listing](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Paseo privacy policy](https://paseo.sh/privacy), [Paseo App Store listing](https://apps.apple.com/us/app/paseo-remote-coding-agents/id6758887924).

Public source inspected at:

- T3 Code `50647de0143e68fde051eb1a0ccf4fe63f9947b2`: [legal URLs](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/mobile/src/features/settings/lib/legal-document-url.ts), marketing privacy page and mobile settings/provider-account flows.
- Paseo `7868f5caf6515543a81ffc58fe941e15e917dcf9`: [relay consent](https://github.com/getpaseo/paseo/blob/7868f5caf6515543a81ffc58fe941e15e917dcf9/packages/app/src/desktop/components/pair-device-section.tsx), English pairing copy, [review lane](https://github.com/getpaseo/paseo/blob/7868f5caf6515543a81ffc58fe941e15e917dcf9/packages/app/fastlane/Fastfile) and release documentation.

These are public-source observations, not walkthroughs of the competitors' installed binaries. Review contacts, private notes, rejected submissions and App Store Connect questionnaires were not available. Their presence in the store does not resolve Milagre's remote-mirroring, generated-code or encryption classification questions. Apple's [5.1.2(i)](https://developer.apple.com/app-store/review/guidelines/#data-use-and-sharing) remains the basis for the AI-sharing disclosure.

## First implementation

The shared consent controller records the disclosure version on the device. One disclosure names all three supported providers because configured advisors or delegated agents can use another provider. It covers prompts, attachments, relevant project files, history and tool results. Browsing existing Chats does not require consent.

Desktop protects local and paired-computer bridges. Mobile protects the shared RPC call boundary, including direct HTTP, LAN and relay routes. Protected actions include sending, Link sending, resume, advisor retry, answers and approvals. Raising the agent permission mode also requires consent; desktop's automatic permission-mode synchronization cannot open a surprise prompt. Stopping and denying remain available. Live Activity answers require an existing decision and never open a prompt from a background task.

Acceptance uses desktop localStorage and existing mobile SecureStore. Failed storage reads or writes block the action. Concurrent actions share one prompt. Reset invalidates a pending decision and requires consent again. It does not cancel an already running agent or delete provider data. Tests cover these boundaries, frozen Electron bridges, native alert behavior and the Settings reset control.

Both platforms expose Privacy & AI Settings, policy links, provider policy links and Support. Pairing also exposes privacy/support links. The website has `/privacy` and `/support` routes and navigation links. The privacy route remains visibly draft and noindex until `SITE_OPERATOR_NAME` and `SITE_CONTACT_EMAIL` are supplied at build time. These values must be confirmed by the operator; setting them does not replace reviewing the policy's operational and retention statements.

## Release conditions still open

1. Confirm the operator/contact details and relay/log retention, finish the policy and publish the website before distributing app links that point to it. Production URLs still return 404 until deployment.
2. Decide the App Privacy answers using actual retention and service contracts. Resolve the remote browser/simulator, generated-preview and encryption questions in the [audit](2026-10-10-app-store-readiness.md).
3. Expand the isolated review environment to cover the submitted feature set without removing its confinement. Prepare reviewer pairing instructions and working contact information.
4. Choose the release build/update pair, align the version, fill App Store metadata and age-rating answers, and capture candidate screenshots.
5. Verify the candidate on physical iPhones, including permission denial, cellular reconnect, notification delivery and locked-screen Live Activities. The new consent checks do not substitute for that release pass.

No App Store metadata write, native build, TestFlight upload, OTA publication or website deployment is part of this implementation.

## Verification

- `npm test -- --unit`: 3,268 tests, 3,257 passed, 11 skipped, zero failures. An earlier remote-computer folder-listing timeout passed on the unchanged baseline and on rerun before this final clean run.
- `npm run typecheck`, `npm run typecheck:mobile`, `npm run build`, and the site build passed. `npm run lint` passed with 1,356 warnings and zero errors. The standalone mobile UI rerun passed all 188 tests before integrating main. The full suite, typechecks, lint and desktop build passed again after resolving the mobile test conflict with main.
- `npm test -- --electron --only ai-consent` passed with screenshots. It exercises frozen local/remote bridges, cancellation, acceptance, persistence after reload, reset and Escape. The targeted shared/mobile/desktop suite passed 232 tests, including denied storage writes and headless actions.
- On iOS 27 simulator `5B487FA2-0A97-4F9F-BBCA-752C67D22D43`, the installed development client loaded this checkout from Metro and the isolated scripted host. Not now restored the draft without a reply; Allow sharing delivered it and received the demo response; Settings read and reset the saved decision. Policy links remained reachable by scrolling. No native build was made. The original stored development-server preference was restored; the current process uses a temporary launch argument. The simulator remains attached for inspection.
- Both built website routes rendered at 390 px without horizontal overflow. Screenshots were inspected. The iOS fingerprint remains `d3dac4031e290045d21303d7735e75e033b14fb0`, matching build 30. Evidence is under `/tmp/milagre-store-audit/screenshots/{desktop,mobile,site}`; private audit responses and pairing credentials elsewhere in that temporary directory must not be shared.

This pass did not test Android on a device, live AI-provider requests, a physical iPhone, delivery of push notifications or a locked-screen Live Activity. Simulator and scripted-host checks do not establish App Store acceptance. The app links must not ship before the public pages are finalized and deployed.
