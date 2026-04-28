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
    if (format === 'gif') return await buildGIF(event, sharp, filePaths, loopCount, quality, width, height, delayMs)
    else return await buildWebP(event, sharp, filePaths, loopCount, quality, width, height, delayMs)
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
    W = Math.round(W * r); H = Math.round(H * r)
  }
  W = Math.max(2, W % 2 === 0 ? W : W - 1)
  H = Math.max(2, H % 2 === 0 ? H : H - 1)

  const rgbFrames = []
  for (let i = 0; i < filePaths.length; i++) {
    event.sender.send('progress', { step: 'load', index: i, total: filePaths.length })
    const buf = await sharp(filePaths[i])
      .resize(W, H, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer()
    rgbFrames.push(buf)
  }

  event.sender.send('progress', { step: 'encode', index: 0, total: rgbFrames.length })

  // 샘플링: 첫 프레임에서만 팔레트 추출 (속도 vs 품질 균형)
  const palette = medianCutIterative(rgbFrames[0], 256)
  const nearest = buildNearestLookup(palette)

  const gifBuf = encodeAnimatedGIF(rgbFrames, W, H, delayMs, loopCount, palette, nearest)
  const tmpPath = path.join(os.tmpdir(), `seq2webp_${Date.now()}.gif`)
  fs.writeFileSync(tmpPath, gifBuf)
  return { success: true, tmpPath, frameCount: filePaths.length, size: gifBuf.length, format: 'gif' }
}

// ---- Median Cut (반복문, 스택오버플로우 없음) ----
function medianCutIterative(rgbBuf, numColors) {
  // 샘플 픽셀 추출 (최대 8000개)
  const total = rgbBuf.length / 3
  const step = Math.max(1, Math.floor(total / 8000))
  const pixels = []
  for (let i = 0; i < total; i += step) {
    pixels.push([rgbBuf[i * 3], rgbBuf[i * 3 + 1], rgbBuf[i * 3 + 2]])
  }

  // 박스 분할 큐 방식 (반복문)
  let boxes = [pixels]
  while (boxes.length < numColors) {
    // 가장 큰 박스 선택
    let maxSize = 0, maxIdx = 0
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length > maxSize) { maxSize = boxes[i].length; maxIdx = i }
    }
    const box = boxes[maxIdx]
    if (box.length <= 1) break

    // 가장 넓은 채널 찾기
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
    for (const p of box) {
      if (p[0] < minR) minR = p[0]; if (p[0] > maxR) maxR = p[0]
      if (p[1] < minG) minG = p[1]; if (p[1] > maxG) maxG = p[1]
      if (p[2] < minB) minB = p[2]; if (p[2] > maxB) maxB = p[2]
    }
    const rRange = maxR - minR, gRange = maxG - minG, bRange = maxB - minB
    const ch = rRange >= gRange && rRange >= bRange ? 0 : gRange >= bRange ? 1 : 2

    box.sort((a, b) => a[ch] - b[ch])
    const mid = Math.floor(box.length / 2)
    boxes.splice(maxIdx, 1, box.slice(0, mid), box.slice(mid))
  }

  // 각 박스의 평균색 = 팔레트
  const palette = boxes.map(box => {
    if (box.length === 0) return [0, 0, 0]
    const r = Math.round(box.reduce((s, p) => s + p[0], 0) / box.length)
    const g = Math.round(box.reduce((s, p) => s + p[1], 0) / box.length)
    const b = Math.round(box.reduce((s, p) => s + p[2], 0) / box.length)
    return [r, g, b]
  })

  while (palette.length < numColors) palette.push([0, 0, 0])
  return palette.slice(0, numColors)
}

// ---- 가장 가까운 팔레트 색 조회 (캐시) ----
function buildNearestLookup(palette) {
  const cache = new Map()
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b
    if (cache.has(key)) return cache.get(key)
    let best = 0, bestDist = Infinity
    for (let i = 0; i < palette.length; i++) {
      const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2]
      const d = dr * dr * 2 + dg * dg * 4 + db * db  // 인간 눈 가중치
      if (d < bestDist) { bestDist = d; best = i }
    }
    cache.set(key, best)
    return best
  }
}

// ---- GIF 인코더 ----
function encodeAnimatedGIF(rgbFrames, w, h, delayMs, loopCount, palette, nearest) {
  const parts = []
  parts.push(Buffer.from('GIF89a'))

  const palBuf = Buffer.alloc(256 * 3)
  for (let i = 0; i < palette.length; i++) {
    palBuf[i * 3] = palette[i][0]
    palBuf[i * 3 + 1] = palette[i][1]
    palBuf[i * 3 + 2] = palette[i][2]
  }

  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2)
  lsd[4] = 0xF7; lsd[5] = 0; lsd[6] = 0
  parts.push(lsd)
  parts.push(palBuf)

  // Netscape loop
  parts.push(Buffer.from([
    0x21, 0xFF, 0x0B,
    0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30,
    0x03, 0x01, loopCount & 0xFF, (loopCount >> 8) & 0xFF, 0x00
  ]))

  const delayCentisec = Math.max(2, Math.round(delayMs / 10))

  for (const rgb of rgbFrames) {
    // GCE
    parts.push(Buffer.from([0x21, 0xF9, 0x04, 0x00, delayCentisec & 0xFF, (delayCentisec >> 8) & 0xFF, 0x00, 0x00]))

    // Image Descriptor
    const imgDesc = Buffer.alloc(10)
    imgDesc[0] = 0x2C
    imgDesc.writeUInt16LE(0, 1); imgDesc.writeUInt16LE(0, 3)
    imgDesc.writeUInt16LE(w, 5); imgDesc.writeUInt16LE(h, 7)
    imgDesc[9] = 0x00
    parts.push(imgDesc)

    // Floyd-Steinberg 디더링
    const indices = new Uint8Array(w * h)
    const errR = new Float32Array(w * h)
    const errG = new Float32Array(w * h)
    const errB = new Float32Array(w * h)

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pi = (y * w + x) * 3
        const r = Math.max(0, Math.min(255, rgb[pi]     + errR[y * w + x]))
        const g = Math.max(0, Math.min(255, rgb[pi + 1] + errG[y * w + x]))
        const b = Math.max(0, Math.min(255, rgb[pi + 2] + errB[y * w + x]))
        const idx = nearest(Math.round(r), Math.round(g), Math.round(b))
        indices[y * w + x] = idx
        const qr = r - palette[idx][0], qg = g - palette[idx][1], qb = b - palette[idx][2]
        if (x + 1 < w)     { errR[y*w+x+1] += qr*7/16; errG[y*w+x+1] += qg*7/16; errB[y*w+x+1] += qb*7/16 }
        if (y + 1 < h) {
          if (x > 0)        { errR[(y+1)*w+x-1] += qr*3/16; errG[(y+1)*w+x-1] += qg*3/16; errB[(y+1)*w+x-1] += qb*3/16 }
                              errR[(y+1)*w+x]   += qr*5/16; errG[(y+1)*w+x]   += qg*5/16; errB[(y+1)*w+x]   += qb*5/16
          if (x + 1 < w)   { errR[(y+1)*w+x+1] += qr*1/16; errG[(y+1)*w+x+1] += qg*1/16; errB[(y+1)*w+x+1] += qb*1/16 }
        }
      }
    }

    const lzw = lzwEncode(indices, 8)
    parts.push(Buffer.from([8]))
    parts.push(lzw)
    parts.push(Buffer.from([0x00]))
  }

  parts.push(Buffer.from([0x3B]))
  return Buffer.concat(parts)
}

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize
  const eofCode = clearCode + 1
  let codeSize = minCodeSize + 1, nextCode = eofCode + 1
  const table = new Map()
  const resetTable = () => {
    table.clear()
    for (let i = 0; i < clearCode; i++) table.set(i, i)
    codeSize = minCodeSize + 1; nextCode = eofCode + 1
  }
  let bitBuf = 0, bitLen = 0
  const bytes = [], blockBuf = []
  const writeBits = (code) => {
    bitBuf |= code << bitLen; bitLen += codeSize
    while (bitLen >= 8) {
      blockBuf.push(bitBuf & 0xFF); bitBuf >>= 8; bitLen -= 8
      if (blockBuf.length === 255) { bytes.push(255, ...blockBuf); blockBuf.length = 0 }
    }
  }
  resetTable(); writeBits(clearCode)
  let prev = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const cur = indices[i]
    const key = (prev << 8) | cur
    if (table.has(key)) { prev = table.get(key) }
    else {
      writeBits(prev)
      if (nextCode < 4096) {
        table.set(key, nextCode++)
        if (nextCode > (1 << codeSize)) codeSize++
      } else { writeBits(clearCode); resetTable() }
      prev = cur
    }
  }
  writeBits(prev); writeBits(eofCode)
  if (bitLen > 0) blockBuf.push(bitBuf & 0xFF)
  if (blockBuf.length > 0) { bytes.push(blockBuf.length, ...blockBuf) }
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
    const fid = src.slice(12, 16).toString('ascii'), fsz = src.readUInt32LE(16)
    if (fid === 'VP8X') {
      let pos = 20 + fsz + (fsz % 2)
      while (pos < src.length - 8) {
        const cid = src.slice(pos, pos + 4).toString('ascii'), csz = src.readUInt32LE(pos + 4)
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
