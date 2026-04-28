const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820, height: 680, minWidth: 660, minHeight: 520,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    title: 'Seq2WebP', backgroundColor: '#ffffff', show: false
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.setMenuBarVisibility(false)
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

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
    console.error('[convert-frames error]', err)
    return { success: false, error: err.message + '\n' + err.stack }
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
  const firstMeta = await sharp(filePaths[0]).metadata()
  const MAX = 800
  let W = width || firstMeta.width
  let H = height || firstMeta.height
  if (!width && !height && (W > MAX || H > MAX)) {
    const r = Math.min(MAX / W, MAX / H)
    W = Math.round(W * r)
    H = Math.round(H * r)
  }
  W = Math.max(2, W % 2 === 0 ? W : W - 1)
  H = Math.max(2, H % 2 === 0 ? H : H - 1)

  console.log(`[GIF] ${W}x${H}, ${filePaths.length} frames, delay=${delayMs}ms`)

  const rgbaFrames = []
  for (let i = 0; i < filePaths.length; i++) {
    event.sender.send('progress', { step: 'load', index: i, total: filePaths.length })
    const buf = await sharp(filePaths[i])
      .resize(W, H, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer()
    rgbaFrames.push(buf)
  }

  event.sender.send('progress', { step: 'encode', index: 0, total: rgbaFrames.length })
  const gifBuf = encodeAnimatedGIF(rgbaFrames, W, H, delayMs, loopCount)
  const tmpPath = path.join(os.tmpdir(), `seq2webp_${Date.now()}.gif`)
  fs.writeFileSync(tmpPath, gifBuf)
  return { success: true, tmpPath, frameCount: filePaths.length, size: gifBuf.length, format: 'gif' }
}

// ---- 순수 JS GIF 인코더 ----
function encodeAnimatedGIF(rgbaFrames, w, h, delayMs, loopCount) {
  const parts = []

  // Header
  parts.push(Buffer.from('GIF89a'))

  // 글로벌 팔레트: 256색 미디안컷 방식 대신 단순 웹 안전 팔레트 사용
  const palette = buildPalette()
  const palSize = 7 // 2^(7+1) = 256 colors

  // Logical Screen Descriptor
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(w, 0)
  lsd.writeUInt16LE(h, 2)
  lsd[4] = 0xF0 | palSize  // global color table flag + size
  lsd[5] = 0               // background color index
  lsd[6] = 0               // pixel aspect ratio
  parts.push(lsd)
  parts.push(palette)

  // Netscape loop extension
  const loop = Buffer.from([
    0x21, 0xFF, 0x0B,
    ...Buffer.from('NETSCAPE2.0'),
    0x03, 0x01,
    loopCount & 0xFF, (loopCount >> 8) & 0xFF,
    0x00
  ])
  parts.push(loop)

  const delayCentisec = Math.max(2, Math.round(delayMs / 10))

  for (const rgba of rgbaFrames) {
    // Graphic Control Extension
    const gce = Buffer.from([
      0x21, 0xF9, 0x04,
      0x00,                          // disposal: no action
      delayCentisec & 0xFF, (delayCentisec >> 8) & 0xFF,
      0x00,                          // transparent index (none)
      0x00
    ])
    parts.push(gce)

    // Image Descriptor
    const imgDesc = Buffer.alloc(10)
    imgDesc[0] = 0x2C
    imgDesc.writeUInt16LE(0, 1)  // left
    imgDesc.writeUInt16LE(0, 3)  // top
    imgDesc.writeUInt16LE(w, 5)
    imgDesc.writeUInt16LE(h, 7)
    imgDesc[9] = 0x00  // no local color table
    parts.push(imgDesc)

    // 픽셀 인덱스 생성 (RGBA → palette index)
    const indices = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const r = rgba[i * 4]
      const g = rgba[i * 4 + 1]
      const b = rgba[i * 4 + 2]
      indices[i] = nearestColor(r, g, b)
    }

    // LZW 압축
    const lzw = lzwEncode(indices, 8)
    parts.push(Buffer.from([8]))  // LZW minimum code size
    parts.push(lzw)
    parts.push(Buffer.from([0x00]))  // block terminator
  }

  parts.push(Buffer.from([0x3B]))  // GIF trailer
  return Buffer.concat(parts)
}

function buildPalette() {
  // 6x6x6 웹 안전 색상 216 + 40개 그레이
  const buf = Buffer.alloc(256 * 3)
  let idx = 0
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) {
        buf[idx++] = r * 51
        buf[idx++] = g * 51
        buf[idx++] = b * 51
      }
  // 나머지 40개: 그레이스케일 보충
  for (let i = 0; i < 40; i++) {
    const v = Math.round(i * 255 / 39)
    buf[idx++] = v; buf[idx++] = v; buf[idx++] = v
  }
  return buf
}

const _palCache = []
function nearestColor(r, g, b) {
  // 6x6x6 큐브에서 가장 가까운 인덱스
  const ri = Math.round(r / 51)
  const gi = Math.round(g / 51)
  const bi = Math.round(b / 51)
  return ri * 36 + gi * 6 + bi
}

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize
  const eofCode = clearCode + 1
  let codeSize = minCodeSize + 1
  let nextCode = eofCode + 1

  const table = new Map()
  const resetTable = () => {
    table.clear()
    for (let i = 0; i < clearCode; i++) table.set(String(i), i)
    codeSize = minCodeSize + 1
    nextCode = eofCode + 1
  }

  let bitBuf = 0, bitLen = 0
  const bytes = []
  const blockBuf = []

  const writeBits = (code) => {
    bitBuf |= code << bitLen
    bitLen += codeSize
    while (bitLen >= 8) {
      blockBuf.push(bitBuf & 0xFF)
      bitBuf >>= 8; bitLen -= 8
      if (blockBuf.length === 255) {
        bytes.push(255)
        bytes.push(...blockBuf)
        blockBuf.length = 0
      }
    }
  }

  resetTable()
  writeBits(clearCode)

  let str = String(indices[0])
  for (let i = 1; i < indices.length; i++) {
    const next = str + ',' + indices[i]
    if (table.has(next)) {
      str = next
    } else {
      writeBits(table.get(str))
      if (nextCode < 4096) {
        table.set(next, nextCode++)
        if (nextCode > (1 << codeSize)) codeSize++
      } else {
        writeBits(clearCode)
        resetTable()
      }
      str = String(indices[i])
    }
  }
  writeBits(table.get(str))
  writeBits(eofCode)

  if (bitLen > 0) blockBuf.push(bitBuf & 0xFF)
  if (blockBuf.length > 0) {
    bytes.push(blockBuf.length)
    bytes.push(...blockBuf)
  }

  return Buffer.from(bytes)
}

ipcMain.handle('save-dialog', async (event, { tmpPath, format }) => {
  const isGif = format === 'gif'
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '저장 위치 선택',
    defaultPath: isGif ? 'animated.gif' : 'animated.webp',
    filters: isGif ? [{ name: 'Animated GIF', extensions: ['gif'] }] : [{ name: 'Animated WebP', extensions: ['webp'] }]
  })
  if (result.canceled) return { saved: false }
  fs.copyFileSync(tmpPath, result.filePath)
  try { fs.unlinkSync(tmpPath) } catch {}
  return { saved: true, filePath: result.filePath }
})

ipcMain.handle('open-file', async (event, filePath) => { shell.showItemInFolder(filePath) })

ipcMain.handle('get-image-size', async (event, filePath) => {
  try { const sharp = require('sharp'); const meta = await sharp(filePath).metadata(); return { width: meta.width, height: meta.height } }
  catch { return null }
})

// ---- Animated WebP builder ----
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
    const src = frameBufs[0]; let off = 12
    while (off < src.length - 8) {
      const cid = src.slice(off, off + 4).toString('ascii')
      const csz = src.readUInt32LE(off + 4)
      if (cid === 'VP8 ') {
        const bs = src.slice(off + 8)
        if (bs[3] === 0x9d && bs[4] === 0x01 && bs[5] === 0x2a) { W = bs.readUInt16LE(6) & 0x3fff; H = bs.readUInt16LE(8) & 0x3fff }
        break
      }
      off += 8 + csz + (csz % 2)
    }
    if (!W) W = 800; if (!H) H = 600
  }
  const vp8xData = Buffer.concat([Buffer.from([0x02, 0x00, 0x00, 0x00]), u24le(W - 1), u24le(H - 1)])
  const animData = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), u16le(loopCount)])
  const anmfChunks = frameBufs.map(src => {
    let bc = null
    const fid = src.slice(12, 16).toString('ascii')
    const fsz = src.readUInt32LE(16)
    if (fid === 'VP8X') {
      let pos = 20 + fsz + (fsz % 2)
      while (pos < src.length - 8) {
        const cid = src.slice(pos, pos + 4).toString('ascii')
        const csz = src.readUInt32LE(pos + 4)
        if (cid === 'VP8 ' || cid === 'VP8L') { bc = chunk(cid, src.slice(pos + 8, pos + 8 + csz)); break }
        pos += 8 + csz + (csz % 2)
      }
    } else { bc = chunk(fid, src.slice(20, 20 + fsz)) }
    if (!bc) return null
    return chunk('ANMF', Buffer.concat([u24le(0), u24le(0), u24le(W - 1), u24le(H - 1), u24le(Math.round(delayMs)), Buffer.from([0x00]), bc]))
  }).filter(Boolean)
  const webpPayload = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', vp8xData), chunk('ANIM', animData), ...anmfChunks])
  return Buffer.concat([Buffer.from('RIFF'), u32le(webpPayload.length), webpPayload])
}
