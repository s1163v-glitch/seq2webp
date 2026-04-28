const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  convertFrames: (opts) => ipcRenderer.invoke('convert-frames', opts),
  saveDialog: (tmpPath) => ipcRenderer.invoke('save-dialog', tmpPath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  getImageSize: (filePath) => ipcRenderer.invoke('get-image-size', filePath),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, data) => cb(data)),
  removeProgressListener: () => ipcRenderer.removeAllListeners('progress')
})
