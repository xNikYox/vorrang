// Brücke zur Oberfläche: nur diese Funktionen sind dort erreichbar.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("vorrang", {
  info: () => ipcRenderer.invoke("info"),
  saveRules: (rules) => ipcRenderer.invoke("rules:save", rules),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  applyQos: () => ipcRenderer.invoke("qos:apply"),
  icons: (paths) => ipcRenderer.invoke("icons", paths),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onState: on("state"),
  onUpdate: on("update"),
  onError: on("error"),
});
