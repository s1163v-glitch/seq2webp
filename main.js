const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 680,
    minWidth: 620,
    minHeight: 520,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'default',
    title: 'Seq2WebP',
    backgroundColor: '#ffffff',
    show: false
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.setMenuBarVisibility(false)
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// --- IPC handlers ---

ipcMain.handle('convert-frames', async (event, opts) => {
  const { filePaths, fps, loopCount, quality, width, height } = opts
  const delayMs = Math.round(1000 / fps)

  try {
    let sharp
    try { sharp = require('sharp') }
    catch (e) { throw new Error('sharp 모듈을 로드할 수 없습니다: ' + e.message) }

    const frames = []
    for (let i = 0; i < filePaths.length; i++) {
      event.sender.send('progress', { step: 'load', index: i, total: filePaths.length })
      const img = sharp(filePaths[i])
      let resized = img
      if (width && height) resized = img.resize(width, height, { fit: 'fill' })
      const webpBuf = await resized.webp({ quality }).toBuffer()
      frames.push(webpBuf)
    }

    event.sender.send('progress', { step: 'encode', index: 0, total: frames.length })

    const animBuf = buildAnimatedWebP(frames, delayMs, loopCount, width, height)

    const tmpPath = path.join(os.tmpdir(), `seq2webp_${Date.now()}.webp`)
    fs.writeFileSync(tmpPath, animBuf)

    return { success: true, tmpPath, frameCount: frames.length, size: animBuf.length }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('save-dialog', async (event, tmpPath) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '저장 위치 선택',
    defaultPath: 'animated.webp',
    filters: [{ name: 'Animated WebP', extensions: ['webp'] }]
  })
  if (result.canceled) return { saved: false }
  fs.copyFileSync(tmpPath, result.filePath)
  fs.unlinkSync(tmpPath)
  return { saved: true, filePath: result.filePath }
})

ipcMain.handle('open-file', async (event, filePath) => {
  shell.showItemInFolder(filePath)
})

ipcMain.handle('get-image-size', async (event, filePath) => {
  try {
    const sharp = require('sharp')
    const meta = await sharp(filePath).metadata()
    return { width: meta.width, height: meta.height }
  } catch { return null }
})

// --- Animated WebP builder (pure JS, same as renderer) ---
function buildAnimatedWebP(frameBufs, delayMs, loopCount, canvasW, canvasH) {
  function u32le(n) {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n >>> 0, 0)
    return b
  }
  function u24le(n) {
    return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff])
  }
  function u16le(n) {
    return Buffer.from([n & 0xff, (n >> 8) & 0xff])
  }
  function chunk(id, data) {
    const idBuf = Buffer.from(id, 'ascii')
    const sizeBuf = u32le(data.length)
    const pad = data.length % 2 !== 0 ? Buffer.from([0]) : Buffer.alloc(0)
    return Buffer.concat([idBuf, sizeBuf, data, pad])
  }

  // Get canvas dimensions from first frame if not specified
  let W = canvasW, H = canvasH
  if (!W || !H) {
    // Parse width/height from VP8 bitstream of first frame
    const src = frameBufs[0]
    // Try to read from VP8 bitstream at offset after RIFF/WEBP/VP8 headers
    // VP8 frame: keyframe starts with 0x9D 0x01 0x2A then width/height
    let off = 12
    while (off < src.length - 8) {
      const cid = src.slice(off, off + 4).toString('ascii')
      const csz = src.readUInt32LE(off + 4)
      if (cid === 'VP8 ') {
        // VP8 bitstream: byte 6 = keyframe marker, 7-9 = start code, 10-11=w, 12-13=h
        const bs = src.slice(off + 8)
        if (bs[3] === 0x9d && bs[4] === 0x01 && bs[5] === 0x2a) {
          W = bs.readUInt16LE(6) & 0x3fff
          H = bs.readUInt16LE(8) & 0x3fff
        }
        break
      }
      off += 8 + csz + (csz % 2)
    }
    if (!W) W = 800
    if (!H) H = 600
  }

  const vp8xData = Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x00]),
    u24le(W - 1),
    u24le(H - 1)
  ])

  const animData = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    u16le(loopCount)
  ])

  const anmfChunks = []
  for (const src of frameBufs) {
    // Extract inner VP8/VP8L chunk from single-frame WebP
    let innerOff = 12
    let bitstreamChunk = null

    const firstChunkId = src.slice(innerOff, innerOff + 4).toString('ascii')
    const firstChunkSz = src.readUInt32LE(innerOff + 4)

    if (firstChunkId === 'VP8X') {
      let pos = innerOff + 8 + firstChunkSz + (firstChunkSz % 2)
      while (pos < src.length - 8) {
        const cid = src.slice(pos, pos + 4).toString('ascii')
        const csz = src.readUInt32LE(pos + 4)
        if (cid === 'VP8 ' || cid === 'VP8L') {
          bitstreamChunk = chunk(cid, src.slice(pos + 8, pos + 8 + csz))
          break
        }
        pos += 8 + csz + (csz % 2)
      }
    } else {
      bitstreamChunk = chunk(firstChunkId, src.slice(innerOff + 8, innerOff + 8 + firstChunkSz))
    }

    if (!bitstreamChunk) continue

    const anmfData = Buffer.concat([
      u24le(0), u24le(0),
      u24le(W - 1), u24le(H - 1),
      u24le(Math.round(delayMs)),
      Buffer.from([0x00]),
      bitstreamChunk
    ])
    anmfChunks.push(chunk('ANMF', anmfData))
  }

  const webpPayload = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    chunk('VP8X', vp8xData),
    chunk('ANIM', animData),
    ...anmfChunks
  ])

  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    u32le(webpPayload.length),
    webpPayload
  ])
}
