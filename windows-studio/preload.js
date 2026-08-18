const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('camswap', {
  onPairingInfo: (callback) => {
    ipcRenderer.on('camswap-pairing', (_event, info) => callback(info));
  },
  getPairingInfo: () => ipcRenderer.invoke('camswap:get-pairing-info'),
  regenerateRoom: () => ipcRenderer.invoke('camswap:regenerate-room')
});
