const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

let mainWindow
let cropWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980, height: 720, minWidth: 780, minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Seq2WebP', backgroundColor: '#ffffff', show: false
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.setMenuBarVisibility(false)
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ──────────────────────────────────────────
// 이미지 시퀀스 → WebP/GIF 변환 (기존)
// ──────────────────────────────────────────
ipcMain.handle('convert-frames', async (event, opts) => {
  const { filePaths, fps, loopCount, quality, width, height, format, paletteSize, blurSigma, dither } = opts
  const delayMs = Math.round(1000 / fps)
  try {
    let sharp
    try { sharp = require('sharp') } catch (e) { throw new Error('sharp 모듈 로드 실패: ' + e.message) }
    if (format === 'gif') return await buildGIF(event, sharp, filePaths, loopCount, quality, width, height, delayMs, paletteSize || 256, blurSigma || 0, dither !== false)
    else return await buildWebP(event, sharp, filePaths, loopCount, quality, width, height, delayMs)
  } catch (err) {
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

async function buildGIF(event, sharp, filePaths, loopCount, quality, width, height, delayMs, paletteSize, blurSigma, dither) {
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
    let pipeline = sharp(filePaths[i]).resize(W, H, { fit: 'fill' })
    if (blurSigma > 0) pipeline = pipeline.blur(blurSigma)
    const buf = await pipeline.removeAlpha().raw().toBuffer()
    rgbFrames.push(buf)
  }
  event.sender.send('progress', { step: 'encode', index: 0, total: rgbFrames.length })
  const palette = medianCutIterative(rgbFrames[0], paletteSize)
  const nearest = buildNearestLookup(palette)
  const gifBuf = encodeAnimatedGIF(rgbFrames, W, H, delayMs, loopCount, palette, nearest, paletteSize, dither)
  const tmpPath = path.join(os.tmpdir(), `seq2webp_${Date.now()}.gif`)
  fs.writeFileSync(tmpPath, gifBuf)
  return { success: true, tmpPath, frameCount: filePaths.length, size: gifBuf.length, format: 'gif' }
}

// ──────────────────────────────────────────
// ffmpeg / ffprobe 경로 헬퍼
// asar 패키징 시 언팩 디렉토리로 지정
// ──────────────────────────────────────────
function getFFmpegPaths() {
  // 일반 실행 시: node_modules에서 직접
  // asar 패키징 시: app.asar.unpacked 에서 찾아야 함
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg')
  const ffprobeInstaller = require('@ffprobe-installer/ffprobe')

  let ffmpegPath = ffmpegInstaller.path
  let ffprobePath = ffprobeInstaller.path

  // asar 환경에서는 .asar → .asar.unpacked 으로 경로 대체
  if (ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')
  }
  if (ffprobePath.includes('app.asar')) {
    ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked')
  }

  return { ffmpegPath, ffprobePath }
}

ipcMain.handle('get-video-info', async (event, filePath) => {
  try {
    const ffmpeg = require('fluent-ffmpeg')
    const { ffmpegPath, ffprobePath } = getFFmpegPaths()
    ffmpeg.setFfmpegPath(ffmpegPath)
    ffmpeg.setFfprobePath(ffprobePath)
    return await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, meta) => {
        if (err) return reject(err)
        const vs = meta.streams.find(s => s.codec_type === 'video')
        if (!vs) return reject(new Error('영상 스트림 없음'))
        const fps = eval(vs.r_frame_rate) || 30
        resolve({
          width: vs.width, height: vs.height,
          fps: Math.round(fps * 10) / 10,
          duration: Math.round(meta.format.duration * 10) / 10,
          totalFrames: Math.round(meta.format.duration * fps)
        })
      })
    })
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('extract-video-frames', async (event, { filePath, fps, startSec, endSec }) => {
  try {
    const ffmpeg = require('fluent-ffmpeg')
    const { ffmpegPath, ffprobePath } = getFFmpegPaths()
    ffmpeg.setFfmpegPath(ffmpegPath)
    ffmpeg.setFfprobePath(ffprobePath)
    const tmpDir = path.join(os.tmpdir(), `seq2webp_vid_${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(filePath)
      if (startSec > 0) cmd = cmd.seekInput(startSec)
      if (endSec > 0) cmd = cmd.duration(endSec - startSec)
      cmd
        .outputOptions([`-vf fps=${fps}`, '-q:v 2'])
        .output(path.join(tmpDir, 'frame_%06d.jpg'))
        .on('progress', (p) => { event.sender.send('progress', { step: 'extract', percent: Math.round(p.percent || 0) }) })
        .on('end', resolve)
        .on('error', reject)
        .run()
    })
    const frames = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg')).sort().map(f => path.join(tmpDir, f))
    return { success: true, frames, tmpDir }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ──────────────────────────────────────────
// 화면 녹화 / 소스 목록
// ──────────────────────────────────────────
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
})

// ──────────────────────────────────────────
// 지정 프레임 오버레이 창
// ──────────────────────────────────────────
ipcMain.handle('open-crop-window', async () => {
  if (cropWindow && !cropWindow.isDestroyed()) { cropWindow.focus(); return }

  const { width, height } = screen.getPrimaryDisplay().bounds

  // preload-overlay.js 경로: asar 환경 대응
  const overlayPreload = path.join(__dirname, 'preload-overlay.js')

  cropWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    webPreferences: {
      preload: overlayPreload,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  cropWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'))
  cropWindow.on('closed', () => { cropWindow = null })
})

ipcMain.handle('confirm-crop', async (event, cropRect) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('crop-result', cropRect)
  }
  if (cropWindow && !cropWindow.isDestroyed()) { cropWindow.close() }
})

ipcMain.handle('cancel-crop', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('crop-result', null)
  }
  if (cropWindow && !cropWindow.isDestroyed()) { cropWindow.close() }
})

// ──────────────────────────────────────────
// 녹화 프레임 저장 로직
// ──────────────────────────────────────────
ipcMain.handle('save-recorded-frames', async (event, { frames, fps, loopCount, quality, width, height, format, paletteSize, blurSigma, dither }) => {
  const tmpDir = path.join(os.tmpdir(), `seq2webp_rec_${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  let sharp
  try { sharp = require('sharp') } catch (e) { return { success: false, error: 'sharp 로드 실패' } }
  const filePaths = []
  for (let i = 0; i < frames.length; i++) {
    const buf = Buffer.from(frames[i].replace(/^data:image\/\w+;base64,/, ''), 'base64')
    const fp = path.join(tmpDir, `frame_${String(i).padStart(6, '0')}.png`)
    fs.writeFileSync(fp, buf)
    filePaths.push(fp)
  }
  const delayMs = Math.round(1000 / fps)
  try {
    let result
    if (format === 'gif') result = await buildGIF(event, sharp, filePaths, loopCount, quality, width, height, delayMs, paletteSize || 256, blurSigma || 0, dither !== false)
    else result = await buildWebP(event, sharp, filePaths, loopCount, quality, width, height, delayMs)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    return result
  } catch (err) {
    return { success: false, error: err.message }
  }
})

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

// ──────────────────────────────────────────
// Median Cut & GIF 인코더
// ──────────────────────────────────────────
function medianCutIterative(rgbBuf, numColors) {
  const total = rgbBuf.length / 3
  const step = Math.max(1, Math.floor(total / 8000))
  const pixels = []
  for (let i = 0; i < total; i += step) pixels.push([rgbBuf[i*3], rgbBuf[i*3+1], rgbBuf[i*3+2]])
  let boxes = [pixels]
  while (boxes.length < numColors) {
    let maxSize=0, maxIdx=0
    for (let i=0; i<boxes.length; i++) { if(boxes[i].length>maxSize){maxSize=boxes[i].length;maxIdx=i} }
    const box = boxes[maxIdx]
    if (box.length <= 1) break
    let minR=255,maxR=0,minG=255,maxG=0,minB=255,maxB=0
    for (const p of box) {
      if(p[0]<minR)minR=p[0];if(p[0]>maxR)maxR=p[0]
      if(p[1]<minG)minG=p[1];if(p[1]>maxG)maxG=p[1]
      if(p[2]<minB)minB=p[2];if(p[2]>maxB)maxB=p[2]
    }
    const rR=maxR-minR,rG=maxG-minG,rB=maxB-minB
    const ch = rR>=rG&&rR>=rB ? 0 : rG>=rB ? 1 : 2
    box.sort((a,b)=>a[ch]-b[ch])
    const mid=Math.floor(box.length/2)
    boxes.splice(maxIdx,1,box.slice(0,mid),box.slice(mid))
  }
  const palette = boxes.map(box => {
    if(!box.length)return[0,0,0]
    const n=box.length
    return[Math.round(box.reduce((s,p)=>s+p[0],0)/n),Math.round(box.reduce((s,p)=>s+p[1],0)/n),Math.round(box.reduce((s,p)=>s+p[2],0)/n)]
  })
  while(palette.length<numColors)palette.push([0,0,0])
  return palette.slice(0,numColors)
}
function buildNearestLookup(palette) {
  const cache = new Map()
  return (r,g,b) => {
    const key=(r<<16)|(g<<8)|b
    if(cache.has(key))return cache.get(key)
    let best=0,bestDist=Infinity
    for(let i=0;i<palette.length;i++){const dr=r-palette[i][0],dg=g-palette[i][1],db=b-palette[i][2];const d=dr*dr*2+dg*dg*4+db*db;if(d<bestDist){bestDist=d;best=i}}
    cache.set(key,best);return best
  }
}
function encodeAnimatedGIF(rgbFrames, w, h, delayMs, loopCount, palette, nearest, paletteSize, dither) {
  const parts=[]
  parts.push(Buffer.from('GIF89a'))
  const palExp=Math.ceil(Math.log2(Math.max(paletteSize,2)))-1
  const palCount=1<<(palExp+1)
  const palBuf=Buffer.alloc(palCount*3)
  for(let i=0;i<palette.length&&i<palCount;i++){palBuf[i*3]=palette[i][0];palBuf[i*3+1]=palette[i][1];palBuf[i*3+2]=palette[i][2]}
  const lsd=Buffer.alloc(7)
  lsd.writeUInt16LE(w,0);lsd.writeUInt16LE(h,2);lsd[4]=0xF0|palExp;lsd[5]=0;lsd[6]=0
  parts.push(lsd);parts.push(palBuf)
  parts.push(Buffer.from([0x21,0xFF,0x0B,0x4E,0x45,0x54,0x53,0x43,0x41,0x50,0x45,0x32,0x2E,0x30,0x03,0x01,loopCount&0xFF,(loopCount>>8)&0xFF,0x00]))
  const delay=Math.max(2,Math.round(delayMs/10))
  const lzwMin=Math.max(2,palExp+1)
  for(const rgb of rgbFrames){
    parts.push(Buffer.from([0x21,0xF9,0x04,0x00,delay&0xFF,(delay>>8)&0xFF,0x00,0x00]))
    const imgDesc=Buffer.alloc(10);imgDesc[0]=0x2C
    imgDesc.writeUInt16LE(0,1);imgDesc.writeUInt16LE(0,3);imgDesc.writeUInt16LE(w,5);imgDesc.writeUInt16LE(h,7);imgDesc[9]=0x00
    parts.push(imgDesc)
    const indices=new Uint8Array(w*h)
    if(dither){
      const errR=new Float32Array((w+1)*(h+1)),errG=new Float32Array((w+1)*(h+1)),errB=new Float32Array((w+1)*(h+1))
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const pi=(y*w+x)*3
        const r=Math.max(0,Math.min(255,rgb[pi]+errR[y*(w+1)+x]))
        const g=Math.max(0,Math.min(255,rgb[pi+1]+errG[y*(w+1)+x]))
        const b=Math.max(0,Math.min(255,rgb[pi+2]+errB[y*(w+1)+x]))
        const idx=nearest(Math.round(r),Math.round(g),Math.round(b));indices[y*w+x]=idx
        const qr=r-palette[idx][0],qg=g-palette[idx][1],qb=b-palette[idx][2]
        if(x+1<w){errR[y*(w+1)+x+1]+=qr*7/16;errG[y*(w+1)+x+1]+=qg*7/16;errB[y*(w+1)+x+1]+=qb*7/16}
        if(y+1<h){
          if(x>0){errR[(y+1)*(w+1)+x-1]+=qr*3/16;errG[(y+1)*(w+1)+x-1]+=qg*3/16;errB[(y+1)*(w+1)+x-1]+=qb*3/16}
          errR[(y+1)*(w+1)+x]+=qr*5/16;errG[(y+1)*(w+1)+x]+=qg*5/16;errB[(y+1)*(w+1)+x]+=qb*5/16
          if(x+1<w){errR[(y+1)*(w+1)+x+1]+=qr*1/16;errG[(y+1)*(w+1)+x+1]+=qg*1/16;errB[(y+1)*(w+1)+x+1]+=qb*1/16}
        }
      }
    } else {
      for(let i=0;i<w*h;i++){const pi=i*3;indices[i]=nearest(rgb[pi],rgb[pi+1],rgb[pi+2])}
    }
    parts.push(Buffer.from([lzwMin]));parts.push(lzwEncode(indices,lzwMin));parts.push(Buffer.from([0x00]))
  }
  parts.push(Buffer.from([0x3B]));return Buffer.concat(parts)
}
function lzwEncode(indices,minCodeSize){
  const clearCode=1<<minCodeSize,eofCode=clearCode+1
  let codeSize=minCodeSize+1,nextCode=eofCode+1
  const table=new Map()
  const initTable=()=>{table.clear();codeSize=minCodeSize+1;nextCode=eofCode+1}
  let bitBuf=0,bitLen=0;const output=[],block=[]
  const flushBlock=()=>{if(block.length>0){output.push(block.length);for(const b of block)output.push(b);block.length=0}}
  const writeBit=(code)=>{bitBuf|=(code<<bitLen);bitLen+=codeSize;while(bitLen>=8){block.push(bitBuf&0xFF);bitBuf=(bitBuf>>8)>>>0;bitLen-=8;if(block.length===255)flushBlock()}}
  initTable();writeBit(clearCode)
  let str=''+indices[0]
  for(let i=1;i<indices.length;i++){
    const next=str+'|'+indices[i]
    if(table.has(next)){str=next}
    else{
      writeBit(str.includes('|')?table.get(str):parseInt(str))
      if(nextCode<4096){table.set(next,nextCode++);if(nextCode>(1<<codeSize)&&codeSize<12)codeSize++}
      else{writeBit(clearCode);initTable()}
      str=''+indices[i]
    }
  }
  writeBit(str.includes('|')?table.get(str):parseInt(str));writeBit(eofCode)
  if(bitLen>0)block.push(bitBuf&0xFF);flushBlock();return Buffer.from(output)
}
function buildAnimatedWebP(frameBufs,delayMs,loopCount,canvasW,canvasH){
  function u32le(n){const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0,0);return b}
  function u24le(n){return Buffer.from([n&0xff,(n>>8)&0xff,(n>>16)&0xff])}
  function u16le(n){return Buffer.from([n&0xff,(n>>8)&0xff])}
  function chunk(id,data){const pad=data.length%2?Buffer.from([0]):Buffer.alloc(0);return Buffer.concat([Buffer.from(id,'ascii'),u32le(data.length),data,pad])}
  let W=canvasW,H=canvasH
  if(!W||!H){const src=frameBufs[0];let off=12;while(off<src.length-8){const cid=src.slice(off,off+4).toString('ascii'),csz=src.readUInt32LE(off+4);if(cid==='VP8 '){const bs=src.slice(off+8);if(bs[3]===0x9d&&bs[4]===0x01&&bs[5]===0x2a){W=bs.readUInt16LE(6)&0x3fff;H=bs.readUInt16LE(8)&0x3fff};break};off+=8+csz+(csz%2)};if(!W)W=800;if(!H)H=600}
  const vp8xData=Buffer.concat([Buffer.from([0x02,0x00,0x00,0x00]),u24le(W-1),u24le(H-1)])
  const animData=Buffer.concat([Buffer.from([0xff,0xff,0xff,0xff]),u16le(loopCount)])
  const anmfChunks=frameBufs.map(src=>{
    let bc=null;const fid=src.slice(12,16).toString('ascii'),fsz=src.readUInt32LE(16)
    if(fid==='VP8X'){let pos=20+fsz+(fsz%2);while(pos<src.length-8){const cid=src.slice(pos,pos+4).toString('ascii'),csz=src.readUInt32LE(pos+4);if(cid==='VP8 '||cid==='VP8L'){bc=chunk(cid,src.slice(pos+8,pos+8+csz));break};pos+=8+csz+(csz%2)}}
    else{bc=chunk(fid,src.slice(20,20+fsz))}
    if(!bc)return null
    return chunk('ANMF',Buffer.concat([u24le(0),u24le(0),u24le(W-1),u24le(H-1),u24le(Math.round(delayMs)),Buffer.from([0x00]),bc]))
  }).filter(Boolean)
  const webpPayload=Buffer.concat([Buffer.from('WEBP'),chunk('VP8X',vp8xData),chunk('ANIM',animData),...anmfChunks])
  return Buffer.concat([Buffer.from('RIFF'),u32le(webpPayload.length),webpPayload])
}
