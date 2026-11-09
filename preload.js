// Narrow bridge between the window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getProfiles: () => ipcRenderer.invoke('profiles:get'),
  setProfiles: list => ipcRenderer.invoke('profiles:set', list),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  rescanFolder: () => ipcRenderer.invoke('folder:rescan'),
  readImage: name => ipcRenderer.invoke('image:read', name),
  readResults: () => ipcRenderer.invoke('data:read', 'results'),
  writeResults: text => ipcRenderer.invoke('data:write', 'results', text),
  readMeasurements: () => ipcRenderer.invoke('data:read', 'measurements'),
  writeMeasurements: text => ipcRenderer.invoke('data:write', 'measurements', text),
  readScale: () => ipcRenderer.invoke('data:read', 'scale'),
  writeScale: text => ipcRenderer.invoke('data:write', 'scale', text),
  writeAnnotated: (name, observer, bytes) => ipcRenderer.invoke('annotated:write', name, observer, bytes),
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
  closeNow: () => ipcRenderer.send('app:close-now'),
});
