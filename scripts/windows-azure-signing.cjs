// electron-builder v26 reads Azure CLI authentication established by azure/login in GitHub Actions.
const { build } = require("../package.json");

module.exports = function windowsAzureSigning(_context, env = process.env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing Windows signing configuration: ${name}`);
    return value;
  };
  const endpoint = required("AZURE_SIGNING_ENDPOINT").replace(/\/$/, "");
  if (!/^https:\/\/[a-z0-9]+\.codesigning\.azure\.net$/.test(endpoint)) throw new Error("Use an Azure Artifact Signing regional HTTPS endpoint.");
  return {
    ...build,
    forceCodeSigning: true,
    win: {
      ...build.win,
      azureSignOptions: {
        endpoint,
        codeSigningAccountName: required("AZURE_SIGNING_ACCOUNT"),
        certificateProfileName: required("AZURE_SIGNING_PROFILE"),
        publisherName: required("AZURE_SIGNING_PUBLISHER"),
      },
    },
  };
};
