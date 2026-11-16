const path = require("node:path");
const { createDesignSettings } = require("../design-settings.cjs");

function registerDeviceNotes({ commands, dataDir, emit }) {
  const deviceNotes = createDesignSettings(path.join(dataDir, "device-notes.json"), { name: "Device notes", missing: false });
  commands.handle("device-notes:read", () => ({ enabled: deviceNotes.enabled() }));
  commands.handle("device-notes:save", (_event, value) => {
    const result = deviceNotes.save(value);
    emit("device-notes:changed", result);
    return result;
  });
  return deviceNotes;
}

module.exports = { registerDeviceNotes };
