/**
 * What the window says when a computer turned this Mac away or can't be reached (spec "Errors"), by PeerError code
 * (peer-client.cjs). `name` is the computer's name; `pairing` is set during Add computer, before it was saved, where
 * unknown-phone means the link's pairing window closed rather than a removal.
 */
function computerProblem(code, { name, pairing = false }) {
  switch (code) {
    case "denied":
      return `${name} didn't allow this Mac.`;
    case "unknown-phone":
      return pairing ? `This link expired. Copy a new one on ${name}.` : `Removed on ${name}. Pair again with a new link.`;
    case "busy":
      return `${name} is answering another computer. Try again in a minute.`;
    case "reset":
      return `${name} was reset. Pair again with a new link.`;
    case "bad-token":
      return pairing ? `This link is out of date. Copy a new one on ${name}.` : `${name} has a new pairing link. Pair again with it.`;
    // A Mac from before PR 1 takes the hello as a phone's, and PR 1's refuse it with reason "kind".
    case "kind":
    case "outdated":
      return `Update Milagre on ${name} to connect.`;
    case "full":
      return `${name} has too many devices connected. Remove one in its Settings › Devices.`;
    case "offline":
      return pairing ? `${name} isn't reachable. Open Milagre on it and check Settings › Devices.` : `${name} is offline.`;
    case "bad-host":
      return `This isn't the Mac the link was made on. Copy a new link on ${name}.`;
    case "bad-hello":
      return `${name} couldn't read this Mac's hello. Copy a new link on it and try again.`;
    case "keys":
      return `This Mac lost its keys for ${name}. Remove it and pair again.`;
    default:
      return pairing ? `Couldn't reach ${name}. Check your connection and try again.` : `${name} is offline.`;
  }
}

module.exports = { computerProblem };
