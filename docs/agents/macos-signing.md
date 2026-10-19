# macOS release signing

Public releases use a **Developer ID Application** certificate for direct distribution, not an Apple Development, Apple Distribution or Developer ID Installer certificate. Both Intel and Apple Silicon builds require signing and Apple notarization.

## Configure the Apple credentials

1. In [Apple Developer Certificates](https://developer.apple.com/account/resources/certificates/list), create a Developer ID Application certificate using a certificate signing request generated on your Mac. Follow [Apple's instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/). Install the downloaded certificate in Keychain Access.
2. In Keychain Access, select the certificate and its private key under **My Certificates**, then export the signing identity as a password-protected `.p12`. A `.cer` alone does not include the private key and cannot sign releases.
3. Find the Team ID in [Apple Developer membership details](https://developer.apple.com/account/).
4. Generate an [app-specific password](https://support.apple.com/pt-br/102654) for notarization from your Apple Account. Use a dedicated password for Milagre, not the account's login password.
5. Add the following repository secrets in [GitHub Actions settings](https://github.com/the-ptf/milagre-ade/settings/secrets/actions):

| Secret                        | Value                                                                     |
| ----------------------------- | ------------------------------------------------------------------------- |
| `CSC_LINK`                    | Base64-encoded Developer ID Application `.p12`, including its private key |
| `CSC_KEY_PASSWORD`            | Password used when exporting the `.p12`                                   |
| `APPLE_ID`                    | Apple Account email used for notarization                                 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Dedicated app-specific password                                           |
| `APPLE_TEAM_ID`               | Team ID associated with the signing certificate                           |

Use the GitHub CLI without placing secret values in shell arguments or history:

```bash
# Replace the path with the exported certificate. Its contents go directly to GitHub.
base64 -i /absolute/path/DeveloperIDApplication.p12 | gh secret set CSC_LINK --repo the-ptf/milagre-ade

# Each command prompts for its value. Do not paste credentials into chat or source files.
gh secret set CSC_KEY_PASSWORD --repo the-ptf/milagre-ade
gh secret set APPLE_ID --repo the-ptf/milagre-ade
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo the-ptf/milagre-ade
gh secret set APPLE_TEAM_ID --repo the-ptf/milagre-ade
```

Do not commit certificates, private keys, passwords or credential files. Keep the exported `.p12` outside the repository. `electron-builder` imports the certificate into a temporary keychain on each macOS runner.

## Release checks

The workflow checks that all five secrets exist before it builds; the tag and GitHub Release are created only after the builds pass. Each macOS job also checks the app-specific password format and authenticates with Apple before installing dependencies. The installer build requires code signing, uses hardened runtime and notarizes the app with `electron-builder`. The app's notarization ticket is stapled before the ZIP and DMG are built.

Apple ID, app-specific password and Team ID have surrounding whitespace removed before both app and DMG notarization. The certificate export password is preserved exactly.

The workflow also signs the DMG, uploads it to Apple and retains the submission ID while waiting. Temporary network failures use up to four attempts with increasing delays; retries during the wait reuse the same submission instead of uploading again. Rejected submissions and authentication failures stop immediately. The workflow requires the explicit `Accepted` status and staples the DMG ticket. The macOS job has a 90-minute limit to allow both app and DMG analysis to finish. Before uploading installers, it verifies the app and DMG signatures, validates stapled tickets, checks Gatekeeper acceptance for the app and verifies DMG integrity. A missing credential, rejected submission or failed check stops the workflow. `npm test -- --only release-workflow` exercises these failure paths without real credentials or Apple requests.

After configuring secrets, merge a Conventional Commit with a `fix:` or `feat:` prefix into `main` to generate a new release. Existing release installers are not automatically replaced by this setup. Download the new DMG through a browser and test installation on a Mac that has no existing Milagre security exception.

## Local builds

Use `npm run package:mac:local` for an ad-hoc build without Apple credentials. It explicitly skips notarization and does not provide Gatekeeper trust. Public releases never use this command.
