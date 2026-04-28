const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 660,
    minHeight: 520,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
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

// --- IPC ---

ipcMain.handle('convert-frames', async (event, opts) => {
  const { filePaths, fps, loopCount, quality, width, height, format } = opts
  const delayMs = Math.round(1000 / fps)
  try {
    let sharp
    try { sharp = require('sharp') } catch (e) { throw new Error('sharp 모듈 로드 실패: ' + e.message) }
    if (format === 'gif') {
      return await buildGIF(event, sharp, filePaths, loopCount, quality, width, height, delayMs)
    } else {
      return await buildWebP(event, sharp, filePaths, loopCount, quality, width, height, delayMs)
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

async function buildWebP(event, sharp, filePaths, loopCount, quality, width, height, delayMs) {
  const frames = []
  for (let i = 0; i < filePaths.length; i++) {
    event.sender.send('progress', { step: 'load', index: i, total: filePaths.length })
    const img = sharp(filePaths[i])
    let resized = (width && height) ? img.resize(width, height, { fit: 'fill' }) : img
    frames.push(await resized.webp({ quality }).toBuffer())
  }
  event.sender.send('progress', { step: 'encode', index: 0, total: frames.length })
  const animBuf = buildAnimatedWebP(frames, delayMs, loopCount, width, height)
  const tmpPath = path.join(os.tmpdir(), `seq2webp_${Date.now()}.webp`)
  fs.writeFileSync(tmpPath, animBuf)
  return { success: true, tmpPath, frameCount: frames.length, size: animBuf.length, format: 'webp' }
}

async function buildGIF(event, sharp, filePaths, loopCount, quality, width, height, delayMs) {
  let GIFEncoder
  try { GIFEncoder = require('gif-encoder-2') } catch (e) { throw new Error('gif-encoder-2 모듈 로드 실패: ' + e.message) }

  const firstMeta = await sharp(filePaths[0]).metadata()

  // GIF 스펙 최대 크기 제한 (65535px), 미입력시 원본 크기 사용
  // 해상도가 너무 크면 자동으로 축소 (GIF는 고해상도에 부적합)
  const MAX_GIF_SIZE = 1920
  let W = width || firstMeta.width
  let H = height || firstMeta.height

  if (!width && !height) {
    // 자동 축소: 긴 변이 MAX_GIF_SIZE 초과 시 비율 유지하며 축소
    if (W > MAX_GIF_SIZE || H > MAX_GIF_SIZE) {
      const ratio = Math.min(MAX_GIF_SIZE / W, MAX_GIF_SIZE / H)
      W = Math.round(W * ratio)
      H = Math.round(H * ratio)
    }
  }

  // 짝수로 맞추기 (GIF 인코더 안정성)
  W = W % 2 === 0 ? W : W - 1
  H = H % 2 === 0 ? H : H - 1

  const encoder = new GIFEncoder(W, H, 'neuquant', true)
  encoder.setDelay(delayMs)
  encoder.setRepeat(loopCount === 0 ? 0 : loopCount)
  encoder.setQuality(Math.max(1, Math.round(1 + (100 - quality) / 100 * 19)))
  encoder.start()

  for (let i = 0; i < filePaths.length; i++) {
    event.sender.send('progress', { step: 'load', index: i, total: filePaths.length })
    const rawBuf = await sharp(filePaths[i])
      .resize(W, H, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer()
    // gif-encoder-2는 Uint8Array를 요구함
    encoder.addFrame(new Uint8Array(rawBuf))
  }

  encoder.finish()
  const gifBuf = encoder.out.getData()
  const tmpPath = path.join(os.tmpdir(), `seq2webp_${Date.now()}.gif`)
  fs.writeFileSync(tmpPath, Buffer.from(gifBuf))
  return { success: true, tmpPath, frameCount: filePaths.length, size: gifBuf.length, format: 'gif' }
}

ipcMain.handle('save-dialog', async (event, { tmpPath, format }) => {
  const isGif = format === 'gif'
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '저장 위치 선택',
    defaultPath: isGif ? 'animated.gif' : 'animated.webp',
    filters: isGif
      ? [{ name: 'Animated GIF', extensions: ['gif'] }]
      : [{ name: 'Animated WebP', extensions: ['webp'] }]
  })
  if (result.canceled) return { saved: false }
  fs.copyFileSync(tmpPath, result.filePath)
  try { fs.unlinkSync(tmpPath) } catch {}
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

// --- Animated WebP builder ---
function buildAnimatedWebP(frameBufs, delayMs, loopCount, canvasW, canvasH) {
  function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b }
  function u24le(n) { return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]) }
  function u16le(n) { return Buffer.from([n & 0xff, (n >> 8) & 0xff]) }
  function chunk(id, data) {
    const pad = data.length % 2 !== 0 ? Buffer.from([0]) : Buffer.alloc(0)
    return Buffer.concat([Buffer.from(id, 'ascii'), u32le(data.length), data, pad])
  }

  let W = canvasW, H = canvasH
  if (!W || !H) {
    const src = frameBufs[0]
    let off = 12
    while (off < src.length - 8) {
      const cid = src.slice(off, off + 4).toString('ascii')
      const csz = src.readUInt32LE(off + 4)
      if (cid === 'VP8 ') {
        const bs = src.slice(off + 8)
        if (bs[3] === 0x9d && bs[4] === 0x01 && bs[5] === 0x2a) {
          W = bs.readUInt16LE(6) & 0x3fff
          H = bs.readUInt16LE(8) & 0x3fff
        }
        break
      }
      off += 8 + csz + (csz % 2)
    }
    if (!W) W = 800; if (!H) H = 600
  }

  const vp8xData = Buffer.concat([Buffer.from([0x02, 0x00, 0x00, 0x00]), u24le(W - 1), u24le(H - 1)])
  const animData = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), u16le(loopCount)])

  const anmfChunks = frameBufs.map(src => {
    let bitstreamChunk = null
    const fid = src.slice(12, 16).toString('ascii')
    const fsz = src.readUInt32LE(16)
    if (fid === 'VP8X') {
      let pos = 20 + fsz + (fsz % 2)
      while (pos < src.length - 8) {
        const cid = src.slice(pos, pos + 4).toString('ascii')
        const csz = src.readUInt32LE(pos + 4)
        if (cid === 'VP8 ' || cid === 'VP8L') { bitstreamChunk = chunk(cid, src.slice(pos + 8, pos + 8 + csz)); break }
        pos += 8 + csz + (csz % 2)
      }
    } else {
      bitstreamChunk = chunk(fid, src.slice(20, 20 + fsz))
    }
    if (!bitstreamChunk) return null
    return chunk('ANMF', Buffer.concat([u24le(0), u24le(0), u24le(W - 1), u24le(H - 1), u24le(Math.round(delayMs)), Buffer.from([0x00]), bitstreamChunk]))
  }).filter(Boolean)

  const webpPayload = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', vp8xData), chunk('ANIM', animData), ...anmfChunks])
  return Buffer.concat([Buffer.from('RIFF'), u32le(webpPayload.length), webpPayload])
}
