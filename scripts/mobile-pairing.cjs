const { computerName, pairingLink } = require("../apps/daemon/src/mobile-pairing.cjs");

function printPairing({
  address,
  token,
  access,
  name = computerName(),
  qr = true,
  log = console.log,
  renderQr = (text, done) => require("qrcode-terminal").generate(text, { small: true }, done),
}) {
  const link = pairingLink({ address, token, name, access });
  log("\nScan with the Milagre app to pair:");
  if (qr) renderQr(link, (code) => log(code));
  log(`Pairing link: ${link}`);
  log("Warning: this QR code and link grant access to your agents. Do not share or screenshot them.\n");
  return link;
}

module.exports = { computerName, pairingLink, printPairing };
