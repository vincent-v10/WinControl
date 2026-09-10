const { contextBridge, ipcRenderer } = require("electron");

// Handed over as argv by main (see additionalArguments) because app.js needs
// the startup skin synchronously, before `new Webamp(...)`. Guarded: a throw in
// a preload script takes the whole renderer down with it.
const PREFIX = "--wincontrol-settings=";
const settings = (() => {
  try {
    return JSON.parse(process.argv.find((a) => a.startsWith(PREFIX)).slice(PREFIX.length));
  } catch {
    return { skin: null, icon: "skin" };
  }
})();

contextBridge.exposeInMainWorld("controller", {
  settings,
  send: (action, arg) => ipcRenderer.invoke("media", action, arg),
  nowPlaying: () => ipcRenderer.invoke("now-playing"),
  backendInfo: () => ipcRenderer.invoke("backend-info"),
  randomSkin: () => ipcRenderer.invoke("random-skin"),
  feed: () => ipcRenderer.invoke("feed"),
  addFeed: (url) => ipcRenderer.invoke("add-feed", url),
  feedMenu: () => ipcRenderer.invoke("feed-menu"),
  openLink: (url) => ipcRenderer.invoke("open-link", url),
  feedHome: () => ipcRenderer.invoke("feed-home"),
  fit: (w, h) => ipcRenderer.send("fit", w, h),
  dockIcon: (dataUrl) => ipcRenderer.send("dock-icon", dataUrl),
  onMenu: (cb) => ipcRenderer.on("menu", (_evt, cmd, arg) => cb(cmd, arg)),
});
