/* Photo picking for the scanner (public homepage and farmer dashboard).
   Resizes to max 1024 px and re-encodes as JPEG so uploads stay under Vercel's ~4.5 MB body limit,
   and makes a small thumbnail that is saved with the scan. */

function initScanner(o) {
  let base64Image = null;
  let thumb = null;

  function reset() {
    o.fileInput.value = '';
    o.preview.src = '';
    o.preview.style.display = 'none';
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
      await o.onScan({ image: base64Image, mediaType: 'image/jpeg', thumb });
    } finally {
      o.loading.style.display = 'none';
      o.scanBtn.disabled = false;
    }
  });

  return { reset };
}
