const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlay', {
  confirmCrop: (rect) => ipcRenderer.invoke('confirm-crop', rect),
  cancelCrop: () => ipcRenderer.invoke('cancel-crop')
})
