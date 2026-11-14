/* Photo picking for the scanner (public homepage and farmer dashboard).
   Resizes to max 1024 px and re-encodes as JPEG so uploads stay under Vercel's ~4.5 MB body limit,
   and makes a small thumbnail that is saved with the scan. */

/* Crop picker shared by the homepage and the farmer dashboard.
   The list comes from the server (lib/crops.js), so there is one source of truth. */
let CROP_CHOICES = [{ id: 'maize', en: 'Maize', rw: 'Ibigori' }];
let cropSelectEl = null;

async function loadCropChoices() {
  try {
    const d = await API.get('/api/climate?action=crops');
    if (Array.isArray(d.crops) && d.crops.length) CROP_CHOICES = d.crops;
  } catch { /* offline: keep maize */ }
}

function renderCropOptions() {
  if (!cropSelectEl) return;
  let keep = cropSelectEl.value;
  if (!keep) { try { keep = localStorage.getItem('crop') || ''; } catch {} }
  cropSelectEl.textContent = '';
  CROP_CHOICES.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = lang === 'rw' ? c.rw : c.en;
    cropSelectEl.appendChild(opt);
  });
  cropSelectEl.value = CROP_CHOICES.some((c) => c.id === keep) ? keep : CROP_CHOICES[0].id;
}

function initCropPicker(select) {
  if (!select) return;
  cropSelectEl = select;
  select.addEventListener('change', () => { try { localStorage.setItem('crop', select.value); } catch {} });
  loadCropChoices().then(() => {
    renderCropOptions();
    // lets a page draw something else that depends on the crop list (the farm checkboxes)
    if (typeof onCropChoicesLoaded === 'function') onCropChoicesLoaded();
  });
  renderCropOptions();
}

function currentCrop() {
  return (cropSelectEl && cropSelectEl.value) || 'maize';
}

function initScanner(o) {
  let base64Image = null;
  let thumb = null;
  initCropPicker(o.cropSelect);

  function reset() {
    o.fileInput.value = '';
    o.preview.src = '';
    o.preview.style.display = 'none';
    if (o.preview.classList) o.preview.classList.remove('shown');
    base64Image = null;
    thumb = null;
    o.scanBtn.disabled = true;
    if (o.onClear) o.onClear();
  }

  function handleFile() {
    const file = o.fileInput.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type || 'image/')) { toast('Choose a photo (image file).', 'bad'); return; }
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const MAX_DIM = 1024;
        let { width, height } = img;
        if (width > height && width > MAX_DIM) { height = Math.round(height * (MAX_DIM / width)); width = MAX_DIM; }
        else if (height > MAX_DIM) { width = Math.round(width * (MAX_DIM / height)); height = MAX_DIM; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const result = canvas.toDataURL('image/jpeg', 0.8);
        thumb = makeThumb(canvas);
        base64Image = result.split(',')[1];
        o.preview.src = result;
        o.preview.style.display = 'block';
        if (o.preview.classList) o.preview.classList.add('shown');
        o.scanBtn.disabled = false;
      };
      img.onerror = () => toast('This photo could not be opened. Try another one.', 'bad');
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  o.fileInput.addEventListener('change', handleFile);
  o.dropzone.addEventListener('click', (e) => { if (e.target !== o.fileInput) o.fileInput.click(); });
  o.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); o.fileInput.click(); } });
  ['dragover', 'dragenter'].forEach((evt) => o.dropzone.addEventListener(evt, (e) => { e.preventDefault(); o.dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((evt) => o.dropzone.addEventListener(evt, (e) => { e.preventDefault(); o.dropzone.classList.remove('drag'); }));
  o.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) { o.fileInput.files = e.dataTransfer.files; handleFile(); }
  });
  o.clearBtn.addEventListener('click', reset);

  o.scanBtn.addEventListener('click', async () => {
    if (!base64Image) return;
    o.loading.style.display = 'block';
    o.scanBtn.disabled = true;
    try {
      await o.onScan({ image: base64Image, mediaType: 'image/jpeg', thumb, crop: currentCrop() });
    } finally {
      o.loading.style.display = 'none';
      o.scanBtn.disabled = false;
    }
  });

  return { reset, renderCropOptions };
}
