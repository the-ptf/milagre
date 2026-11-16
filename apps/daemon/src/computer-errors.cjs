const { thisComputer, ThisComputer } = require("@milagre/shared/host-computer");

function computerProblem(code, { name, pairing = false }) {
  switch (code) {
    case "denied":
      return `${name} didn't allow ${thisComputer}.`;
    case "unknown-phone":
      return pairing ? `This link expired. Copy a new one on ${name}.` : `Removed on ${name}. Pair again with a new link.`;
    case "busy":
      return `${name} is answering another computer. Try again in a minute.`;
    case "reset":
      return `${name} was reset. Pair again with a new link.`;
    case "bad-token":
      return pairing ? `This link is out of date. Copy a new one on ${name}.` : `${name} has a new pairing link. Pair again with it.`;
    case "kind":
    case "outdated":
      return `Update Milagre on ${name} to connect.`;
    case "full":
      return `${name} has too many devices connected. Remove one in its Settings › Phone & sharing.`;
    case "offline":
      return pairing ? `${name} isn't reachable. Open Milagre on it and check Settings › Phone & sharing.` : `${name} is offline.`;
    case "bad-host":
      return `This isn't the computer the link was made on. Copy a new link on ${name}.`;
    case "bad-hello":
      return `${name} couldn't read ${thisComputer}'s hello. Copy a new link on it and try again.`;
    case "keys":
      return `${ThisComputer} lost its keys for ${name}. Remove it and pair again.`;
    default:
      return pairing ? `Couldn't reach ${name}. Check your connection and try again.` : `${name} is offline.`;
  }
}

module.exports = { computerProblem };
