const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 기존 기능
  convertFrames: (opts) => ipcRenderer.invoke('convert-frames', opts),
  saveDialog: (opts) => ipcRenderer.invoke('save-dialog', opts),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  getImageSize: (filePath) => ipcRenderer.invoke('get-image-size', filePath),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, data) => cb(data)),
  removeProgressListener: () => ipcRenderer.removeAllListeners('progress'),

  // 영상 변환
  extractVideoFrames: (opts) => ipcRenderer.invoke('extract-video-frames', opts),
  getVideoInfo: (filePath) => ipcRenderer.invoke('get-video-info', filePath),

  // 화면 녹화
  getSources: () => ipcRenderer.invoke('get-sources'),
  startRecording: (opts) => ipcRenderer.invoke('start-recording', opts),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  saveRecordedFrames: (opts) => ipcRenderer.invoke('save-recorded-frames', opts),
  onRecordProgress: (cb) => ipcRenderer.on('record-progress', (_e, data) => cb(data)),
  removeRecordListener: () => ipcRenderer.removeAllListeners('record-progress')
})
