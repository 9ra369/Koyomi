const { contextBridge, ipcRenderer } = require("electron");

// ADR-2 / ADR-8: 公開するAPIは loadState / saveState の2本のみに絞る
contextBridge.exposeInMainWorld("koyomi", {
  loadState: () => ipcRenderer.invoke("koyomi:loadState"),
  saveState: (state) => ipcRenderer.invoke("koyomi:saveState", state),
});
