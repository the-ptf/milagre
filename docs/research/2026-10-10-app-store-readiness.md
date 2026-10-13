# App Store readiness audit

This is the pre-implementation snapshot. See the [comparison and implementation report](2026-10-10-app-store-comparison.md) for fixes, final checks and remaining release conditions.

Milagre is not ready to submit. The App Store draft has missing submission fields, the app has no privacy policy link or AI data-sharing consent, and the review demo excludes shipping features.

Checked October 10, 2026 against Apple's live documentation, App Store Connect, EAS, source commit `e3768cd6c07a1ce294501c4b852ee267e3e3232a`, and the downloaded distribution IPAs for builds 24 and 30. This is an audit, not an approval prediction. No production configuration, App Store fields, builds, or updates were changed.

## Release evidence

| Item                       | Observed state                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| App                        | Milagre, `6818804252`, `com.victorlucas.milagre`                                                                                            |
| App Store version          | `1.0`, `PREPARE_FOR_SUBMISSION`                                                                                                             |
| Selected build             | `0.1.0 (24)`, uploaded October 7, processing `VALID`, App Store eligible, external beta testing enabled                                     |
| Newest uploaded build      | `0.1.0 (30)`, uploaded October 9, processing `VALID`, App Store eligible, internal beta testing; external state `READY_FOR_BETA_SUBMISSION` |
| Current source fingerprint | `d3dac4031e290045d21303d7735e75e033b14fb0`, after applying the repository's dependency patches                                              |
| Build 30 runtime           | Matches current source fingerprint                                                                                                          |
| Build 24 runtime           | `f730838b75c8408d60b4ce790d48644cff932081`, does not match current source                                                                   |
| Latest iOS OTA             | Group `dec1029b-70f5-47ef-acce-2d14264e2d6a`, October 10 at 16:37 UTC, current source commit, build 30 runtime, `testflight` channel        |
| Distribution IPAs          | Both: Xcode metadata `2660`, `iphoneos26.5`, minimum iOS 16.4, iPhone device family only                                                    |
| Live Activities            | Build 24: absent. Build 30: enabled with `MilagreAgentActivity.appex`                                                                       |

The installed app can differ from its embedded JavaScript after OTA. Release validation must record both the build and update ID. Selecting build 24 would leave reviewers on an older native runtime that cannot receive the latest update. The draft's `1.0` also differs from both builds' `0.1.0`; reconcile the release version before submission.

## Confirmed blockers and fixes

### 1. Privacy policy and support are missing

**Evidence:** App Store Connect's en-US `privacyPolicyUrl` and `supportUrl` are null. `https://milagre.cloud/privacy` and `/support` returned HTTP 404. The site has no privacy/support page, and `apps/mobile/src/app/settings.tsx` has no policy or support link. A search of desktop source also found no privacy consent flow.

**Fix:** Publish a policy and a support page with a working contact method. Link them from mobile and desktop Settings and expose the policy before pairing. Fill the corresponding App Store fields. Describe actual storage, third parties, retention, removal, and consent withdrawal; do not promise that all data stays on the Mac. Policy links are required in both the app and metadata under [5.1.1](https://developer.apple.com/app-store/review/guidelines/#privacy).

**Shipping:** Website and JS changes can avoid a new native build. Public policy wording still needs accurate operator/contact and retention facts.

### 2. No explicit AI data-sharing consent

**Evidence:** `apps/mobile/src/app/chat.tsx:599` sends text, attachments, and context to the connected computer, which invokes the selected provider. Pairing and Settings provide no disclosure/consent gate. Account selection identifies a provider but does not explain what it receives. Desktop has the same gap. Tool-execution approvals serve a different purpose.

**Fix:** Before first transmission, identify the provider and the categories sent, including messages, photos/files, and relevant Project context. Offer an explicit choice, preserve refusal, and handle provider changes and withdrawal. Gate all entry points, including generated UI actions and design feedback. Share the behavior across desktop and mobile. This addresses [5.1.2(i)](https://developer.apple.com/app-store/review/guidelines/#data-use-and-sharing), which specifically covers third-party AI.

**Shipping:** JS/shared logic. Do not treat an existing provider sign-in as evidence that this disclosure already happened.

### 3. App Store metadata is largely empty

**Evidence:** Live App Store Connect reads returned the following:

| Field                                    | Result                              |
| ---------------------------------------- | ----------------------------------- |
| Description, keywords, support URL       | Null                                |
| Privacy policy URL                       | Null                                |
| Primary category                         | Null                                |
| Copyright and content rights declaration | Null                                |
| Age-rating questionnaire                 | Unanswered; individual answers null |
| Screenshot sets                          | Zero                                |
| App Store review contact and notes       | No review-detail record             |

Subtitle, marketing URL, and promotional text are also empty, but are not all mandatory. TestFlight's description and review notes do not populate the App Store version.

**Fix:** Complete the draft after choosing the release candidate. Explain the computer and provider-account requirements. Answer the age questionnaire using the actual AI, browser, and preview behavior, rather than assuming a low rating because this is a developer tool. Apple has required the updated questionnaire since January 31, 2026. [Current requirements](https://developer.apple.com/news/upcoming-requirements/).

Capture real app screens from the candidate. Apple's current screenshot page lists an iPhone Dynamic Island medium-display set, with portrait dimensions including 1179 x 2556 and 1206 x 2622, and scaling rules for other sets. Both IPAs are iPhone-only; an iPad-specific set is not indicated by their device-family configuration. Images must have no alpha channel. Recheck the live uploader's required wells when uploading; the skill's older 6.9-inch summary is not the current page wording. [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).

**Shipping:** App Store Connect and screenshot work, no native change unless the chosen version requires one.

### 4. Review access does not cover the shipping app

**Evidence:** TestFlight notes provide a private pairing link to a scripted demo computer. They explicitly say notifications are disabled and enabling them gives a retry message. `apps/daemon/src/confine.cjs:209` rejects push registration. The confinement also restricts Accounts, MCP, and simulator access; `apps/daemon/src/demo-agent.cjs:146` substitutes a scripted provider and refuses pull-request access. The current demo tests pass, but this is not evidence that the full product is reviewable.

**Fix:** Prepare an isolated, persistent review environment that exposes the shipping flows with safe sample data and functional notifications. Preserve isolation from personal Projects and credentials. Provide the pairing link, exact steps, contact details, and an accurate explanation of any remaining limitations in the App Store review record. Verify fresh pairing from an external network and repeat after restart. A video can supplement access, not establish that disabled features work. [Guideline 2.1 and review access](https://developer.apple.com/app-store/review/guidelines/#app-completeness).

**Shipping:** Demo-host and review-information work. Do not remove confinement from the existing demo merely to make controls work.

## Questions to close before release

| Risk                                    | Evidence and required decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy labels and manifests            | Both IPAs contain 11 manifests, with empty collected-data arrays and tracking false. Required-reason categories are present. This does not establish that the app collects no data. Inspect the App Privacy questionnaire and reconcile it with retention by AI providers, Expo, Apple, Cloudflare, and configured tools. The questionnaire was not read in this audit.                                                                                                                                                       |
| Remote browser/simulator classification | `apps/mobile/src/browser.tsx` and `simulator.tsx` stream and control specific software on the paired computer over LAN or internet relay. Assess [4.2.7](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality), whose specific-software mirroring provisions include LAN and host-ownership restrictions. Applicability to this developer companion is an interpretation risk, not a confirmed rejection. Explain the architecture and seek clarification if relying on a different classification. |
| Generated previews and OTA              | `artifact.tsx` runs generated HTML/JS in a sandboxed WebView; the generated UI renderer uses a fixed component library. Document those boundaries and assess [2.5.2 and 4.7](https://developer.apple.com/app-store/review/guidelines/). OTA runtime compatibility alone does not establish policy compliance. Do not use updates to introduce unreviewed functionality during review.                                                                                                                                         |
| Encryption exemption                    | Both IPAs declare `ITSAppUsesNonExemptEncryption=false`, while `packages/shared/src/relay-crypto.mjs` uses TweetNaCl box/secretbox/signatures. This exceeds OS-only HTTPS. Determine the applicable exemption and destination-specific documentation before accepting that declaration. Do not automatically flip it to true: bundled cryptography alone does not decide exemption. [Apple's encryption guidance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).           |
| Permission wording                      | Both IPAs contain a microphone purpose string asserting that iOS asks because the scanner shares the camera. Source calls camera-only permission APIs; no app microphone permission request was found. Their camera string mentions QR pairing but omits taking Chat photos. Reconcile the actual native permission strings and test refusal paths. The unused microphone string is cleanup/risk, not proof that a microphone prompt appears.                                                                                 |

Changing native permission strings, manifest configuration, or encryption keys requires a fingerprint check and may require a new build. Under `apps/mobile/AGENTS.md`, obtain approval before writing a change that requires that build. No such change or build was made here.

## Data-flow evidence for privacy work

| Flow                 | Source evidence                                                                                                                  | Disclosure work                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pairing and relay    | Secure storage on phone; `relay-crypto.mjs` encrypts traffic. `apps/relay/src/worker.ts` persists a room ID and socket metadata. | Separate encrypted content from visible routing metadata. Confirm provider logging and retention.                                                       |
| Chat and attachments | `chat.tsx:599`, provider runtime on the computer                                                                                 | Determine provider retention/settings and classify user content, photos/files, and identifiers. Include configured tools/MCP destinations.              |
| Push notifications   | `apps/daemon/src/mobile-push.cjs:119` sends token, Chat title/preview, Project path, session and host identifiers through Expo.  | Push content is not end-to-end encrypted. Mobile notification settings already disclose Expo/Apple/Google processing; the policy and labels must agree. |
| Local removal        | `apps/mobile/src/app/index.tsx:99`, `hosts-store.ts`, push unregister retry                                                      | Forgetting a computer is not deletion of the computer's Chats or provider records. State what remains and how to remove it.                             |
| Updates              | Both IPAs fetch from `u.expo.dev` on the `testflight` channel                                                                    | Confirm update-service request data/retention and include it where applicable.                                                                          |

Apple defines collection in terms of off-device access beyond servicing a request in real time. Transmission, encryption, optionality, and local storage do not by themselves settle the privacy-label answers. No final data-type selections are asserted here. [App Privacy details](https://developer.apple.com/app-store/app-privacy-details/).

The main app manifests declare file timestamps (`C617.1`, `0A2A.1`, `3B52.1`), UserDefaults (`CA92.1`), system boot time (`35F9.1`), and disk space (`E174.1`, `85F4.1`). SDK manifests are present for React, Expo, SDWebImage, and ReachabilitySwift. Existence and parseability were checked; per-call justification and a complete symbol-to-bundle inventory were not. The custom widget has no separate manifest; reviewed widget source did not establish a required-reason API use, so this is not flagged as an automatic defect. [Required-reason API rules](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api).

## Checks that passed or did not reveal a blocker

| Check                   | Result                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload toolchain        | Both IPAs meet the current Xcode 26 / iOS 26 SDK floor and iOS 13 minimum deployment floor. [Apple requirements](https://developer.apple.com/news/upcoming-requirements/).                                                                                                                                                              |
| Signing configuration   | Both main apps have production APNs and `get-task-allow=false`; build 30's widget also has `get-task-allow=false`. This was entitlement inspection, not a new upload validation.                                                                                                                                                        |
| Broad native privileges | No general ATS bypass, background-mode declaration, or ATT usage string in either main plist. Local networking is allowed.                                                                                                                                                                                                              |
| Payments                | No purchase, checkout, or subscription-selling flow found in reviewed mobile source. Do not add IAP merely because provider accounts can be paid; reassess if Milagre sells access or directs purchases. [Payment rules](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase).                                     |
| Login and deletion      | Accounts here are provider profiles on a paired computer, not a Milagre account signup. No missing Sign in with Apple or Milagre account-deletion blocker established. Reassess if primary account creation is added. [Account deletion scope](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion). |
| Permission timing       | Camera use is user initiated; pairing also accepts a pasted link. Notifications are optional. Real-device denial/recovery still needs verification.                                                                                                                                                                                     |
| Relay availability      | Public `/health` returned `ok`; this does not prove the private review computer is online or pairable.                                                                                                                                                                                                                                  |

## Verification and remaining coverage

`npm run typecheck` and `npm run typecheck:mobile` passed. `npm run lint` completed with 1,352 existing warnings and no error diagnostics. The targeted command `node --test scripts/review-demo.test.cjs scripts/mobile-ui.test.cjs apps/relay/src/room.test.mjs` passed 222 tests.

`npm test -- --unit` ran 3,252 tests: 3,240 passed, 11 skipped, and one failed at `packages/core/src/terminals.test.cjs:260` with `posix_spawnp failed`. The fresh `npm ci --ignore-scripts` install left node-pty's published `spawn-helper` without its execute bit. Running the repository's existing `node scripts/prepare-node-pty.cjs` corrected local dependency permissions; all 15 tests in `packages/core/src/terminals.test.cjs`, including the real PTY test, then passed. The entire suite was not repeated after that environment fix. No product-code fix was needed.

No new archive, upload, OTA, App Store metadata write, or public deployment was performed. Dependencies were installed locally and repository patches applied. Only this audit document was added to tracked source. Private API responses, IPA downloads, and logs are outside the repository in `/tmp/milagre-store-audit`; they include private review information and must not be committed or shared wholesale.

This audit did not perform a real-device walkthrough, crash-session review, runtime traffic capture, privacy-label UI read, agreement/trader-status check, pricing/territory check, or App Store validation submission. It cannot certify those areas. No production review pairing token was used to mutate the demo.

## Next work, in order

1. Add policy/support pages and links, plus shared AI consent on desktop and mobile. Confirm the operator/contact and retention facts before publishing.
2. Resolve privacy declarations and the remote-control/encryption questions. Separate JS fixes from native changes requiring approval.
3. Make the isolated review environment cover the submitted feature set, including notifications, and prepare App Store review instructions.
4. Choose the build/update pair, align the version, and complete metadata, age rating, screenshots, App Privacy, availability, and required business declarations.
5. Walk through that candidate on real iPhones: fresh pairing and denied permissions; Chat/attachments/approvals; reconnect on Wi-Fi and cellular/IPv6; push and locked-screen Live Activities; forget/re-pair. Record crashes, screenshots, and the exact build/update before submission.
