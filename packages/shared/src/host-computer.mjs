const mac = typeof process !== "undefined" && process.platform === "darwin";

export const thisComputer = mac ? "this Mac" : "this computer";
export const ThisComputer = mac ? "This Mac" : "This computer";
export const computerNoun = mac ? "Mac" : "computer";
export const fileManager = mac ? "Finder" : process.platform === "win32" ? "File Explorer" : "file manager";
