# Windows signing

The release workflow supports a certificate (`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`) or Azure Artifact Signing. Candidate builds in `package-candidates.yml` remain unsigned. The separate **Build signed Windows candidate** workflow creates a signed installer as an Actions artifact without publishing a release.

## Azure Artifact Signing

Individual developers in Canada and the United States can apply for Public Trust. The Microsoft account's Azure billing account must be Individual; its legal name and sold-to address must match the government ID used for validation. Complete identity validation in the Azure portal. The certificate publisher is the validated legal name, including for an app named Milagre.

The account owner completes sign-in, billing and identity validation. Use the Basic tier unless more capacity is needed; check current regional pricing before creating the resource. Creating a local self-signed certificate does not replace Public Trust validation.

1. Follow [Microsoft's quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart): create an Artifact Signing account, complete Individual identity validation, and create a **Public Trust** certificate profile.
2. Create an Entra app registration and service principal for GitHub Actions. Assign the certificate profile's **Artifact Signing Certificate Profile Signer** role (previously Trusted Signing Certificate Profile Signer). Grant access at the certificate profile scope.
3. Create the repository environment `windows-signing`. Configure its allowed deployment branches before enabling signing. Add an Entra federated credential for this repository and environment, with issuer `https://token.actions.githubusercontent.com` and audience `api://AzureADTokenExchange`. Use the actual OIDC subject emitted by this repository: renamed repositories can use immutable repository IDs, so do not assume the older `repo:owner/name:environment:windows-signing` format. Follow [GitHub's Azure OIDC guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure).
4. Store `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` as secrets in that environment. No client secret or exported signing key is needed; `azure/login` authenticates using OIDC and electron-builder uses its Azure CLI session.
5. Add these environment variables in GitHub:

| Variable                   | Value                                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| `AZURE_SIGNING_ENDPOINT`   | The account's regional endpoint, for example `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT`    | Artifact Signing account name                                                    |
| `AZURE_SIGNING_PROFILE`    | Public Trust certificate profile name                                            |
| `AZURE_SIGNING_PUBLISHER`  | The certificate's exact Common Name (CN)                                         |
| `WINDOWS_SIGNING_PROVIDER` | `azure`                                                                          |

6. Run **Build signed Windows candidate** against the desired branch with an `X.Y.Z` version. It verifies Authenticode on both the installer and app executable, installs into a disposable destination, exercises the packaged app, and uploads `signed-windows-X.Y.Z`. The workflow must exist on the default branch before its first dispatch. The existing unsigned candidate remains available while identity validation is pending.
7. After the signed candidate passes, set the repository variable `RELEASE_WINDOWS=true` to include Windows in releases. Keep it disabled while setting up credentials. The Publish workflow uses the same Azure configuration and still supports the original certificate mode when `WINDOWS_SIGNING_PROVIDER` is unset or `certificate`.

The Azure build uses `scripts/windows-azure-signing.cjs` with electron-builder v26's `win.azureSignOptions`; it preserves the normal packaging configuration and requires code signing. A missing publisher/profile/endpoint fails instead of falling back to an unsigned build. Signing establishes publisher identity, but does not guarantee that a new release bypasses SmartScreen reputation checks.

Sources: [electron-builder v26 Azure signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/), [Microsoft signing options and SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).
