const { ipcRenderer } = require("electron");

window.bench = { invoke: (method, request) => ipcRenderer.invoke("simulator", method, request) };
