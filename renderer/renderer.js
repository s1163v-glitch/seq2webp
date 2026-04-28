/* renderer.js */

const dropZone = document.getElementById('drop-zone')
const fileInput = document.getElementById('file-input')
const fileList = document.getElementById('file-list')
const fileCount = document.getElementById('file-count')
const clearBtn = document.getElementById('clear-btn')
const convertBtn = document.getElementById('convert-btn')
const saveBtn = document.getElementById('save-btn')
const fpsInput = document.getElementById('fps-input')
const loopSelect = document.getElementById('loop-select')
const widthInput = document.getElementById('width-input')
const heightInput = document.getElementById('height-input')
const qualityInput = document.getElementById('quality-input')
const qualityVal = document.getElementById('quality-val')
const progressWrap = document.getElementById('progress-wrap')
const progressFill = document.getElementById('progress-fill')
const progressLabel = document.getElementById('progress-label')
const previewImg = document.getElementById('preview-img')
const previewEmpty = document.getElementById('preview-empty')
const outputInfo = document.getElementById('output-info')
const errorBar = document.getElementById('error-bar')
const fmtBtns = document.querySelectorAll('.fmt-btn')

let files = []
let lastTmpPath = null
let lastFormat = 'webp'
let lastObjectUrl = null

// Format toggle
fmtBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    fmtBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    lastFormat = btn.dataset.fmt
  })
})

qualityInput.addEventListener('input', () => { qualityVal.textContent = qualityInput.value })

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'))
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag')
  handleFiles([...e.dataTransfer.files])
})
fileInput.addEventListener('change', e => handleFiles([...e.target.files]))
clearBtn.addEventListener('click', reset)

function reset() {
  files = []
  fileInput.value = ''
  fileList.innerHTML = ''
  fileCount.textContent = '0개 파일'
  clearBtn.style.display = 'none'
  convertBtn.disabled = true
  saveBtn.style.display = 'none'
  previewImg.style.display = 'none'
  previewEmpty.style.display = ''
  outputInfo.style.display = 'none'
  hideError()
  if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null }
}

function showError(msg) { errorBar.textContent = msg; errorBar.style.display = 'block' }
function hideError() { errorBar.style.display = 'none' }

function naturalSort(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

function handleFiles(newFiles) {
  hideError()
  const allowed = ['png','jpg','jpeg','tif','tiff','webp','bmp']
  const valid = newFiles.filter(f => allowed.includes(f.name.split('.').pop().toLowerCase()))
  if (!valid.length) { showError('지원하는 이미지 파일이 없습니다.'); return }
  files = [...files, ...valid].sort(naturalSort)
  renderList()
  convertBtn.disabled = files.length < 2
  clearBtn.style.display = 'inline'
  saveBtn.style.display = 'none'
  outputInfo.style.display = 'none'
}

function renderList() {
  fileList.innerHTML = ''
  files.forEach((f, i) => {
    const item = document.createElement('div')
    item.className = 'file-item'
    const num = document.createElement('span')
    num.className = 'file-num'
    num.textContent = i + 1
    const ext = f.name.split('.').pop().toLowerCase()
    const isTiff = ['tif','tiff'].includes(ext)
    let thumb
    if (!isTiff && f instanceof File) {
      thumb = document.createElement('img')
      thumb.className = 'file-thumb'
      const url = URL.createObjectURL(f)
      thumb.src = url
      thumb.onload = () => URL.revokeObjectURL(url)
    } else {
      thumb = document.createElement('div')
      thumb.className = 'file-ext-badge'
      thumb.textContent = ext.toUpperCase()
    }
    const name = document.createElement('span')
    name.className = 'file-name'
    name.textContent = f.name
    item.appendChild(num)
    item.appendChild(thumb)
    item.appendChild(name)
    fileList.appendChild(item)
  })
  fileCount.textContent = `${files.length}개 파일`
}

convertBtn.addEventListener('click', async () => {
  if (files.length < 2) return
  hideError()

  const fps = Math.max(1, Math.min(60, parseInt(fpsInput.value) || 12))
  const loopCount = parseInt(loopSelect.value)
  const quality = parseInt(qualityInput.value)
  const outW = parseInt(widthInput.value) || null
  const outH = parseInt(heightInput.value) || null

  const filePaths = files.map(f => f.path).filter(Boolean)
  if (filePaths.length !== files.length) {
    showError('파일 경로를 읽을 수 없습니다. 파일을 다시 선택해주세요.')
    return
  }

  convertBtn.disabled = true
  saveBtn.style.display = 'none'
  outputInfo.style.display = 'none'
  progressWrap.style.display = 'flex'
  progressFill.style.width = '0%'

  window.api.removeProgressListener()
  window.api.onProgress(({ step, index, total }) => {
    if (step === 'load') {
      progressFill.style.width = Math.round((index / total) * 85) + '%'
      progressLabel.textContent = `이미지 로딩 중 (${index + 1} / ${total})`
    } else if (step === 'encode') {
      progressFill.style.width = '90%'
      progressLabel.textContent = `${lastFormat.toUpperCase()} 합성 중...`
    }
  })

  const result = await window.api.convertFrames({
    filePaths, fps, loopCount, quality,
    width: outW, height: outH,
    format: lastFormat
  })

  progressFill.style.width = '100%'

  if (!result.success) {
    showError('오류: ' + result.error)
    convertBtn.disabled = false
    progressWrap.style.display = 'none'
    return
  }

  lastTmpPath = result.tmpPath
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl)

  const fileUrl = 'file://' + result.tmpPath.replace(/\\/g, '/')
  previewImg.src = fileUrl + '?t=' + Date.now()
  previewImg.style.display = 'block'
  previewEmpty.style.display = 'none'

  const sizeKB = Math.round(result.size / 1024)
  const sizeLabel = sizeKB > 1024 ? (sizeKB / 1024).toFixed(1) + ' MB' : sizeKB + ' KB'
  outputInfo.textContent = `${result.frameCount}프레임 · ${fps}fps · ${result.format.toUpperCase()} · ${sizeLabel}`
  outputInfo.style.display = 'block'

  saveBtn.style.display = 'inline'
  convertBtn.disabled = false
  setTimeout(() => { progressWrap.style.display = 'none'; progressFill.style.width = '0%' }, 1200)
})

saveBtn.addEventListener('click', async () => {
  if (!lastTmpPath) return
  const result = await window.api.saveDialog({ tmpPath: lastTmpPath, format: lastFormat })
  if (result.saved) {
    lastTmpPath = null
    saveBtn.style.display = 'none'
    outputInfo.textContent = outputInfo.textContent + ' — 저장 완료 ✓'
    window.api.openFile(result.filePath)
  }
})
