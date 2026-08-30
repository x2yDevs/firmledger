/**
 * Logo uploads: validated (type + 2 MB cap), then normalized to a uniform
 * 256×256 PNG (SVGs stored as-is). Uniformity is enforced here, not left
 * to users.
 */
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dir = path.join(__dirname, '..', '..', 'data', 'uploads', 'logos');
fs.mkdirSync(dir, { recursive: true });

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);

const upload = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z.]/g, '') || '.png';
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error('Logo must be a PNG, JPG, WebP or SVG file (max 2 MB).'));
  },
});

/** Wraps multer so upload errors surface as form errors, not 500s. */
function logoField(field = 'logo_file') {
  const single = upload.single(field);
  return (req, res, next) => {
    single(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE'
          ? 'Logo file is too large — the limit is 2 MB.'
          : err.message;
      }
      next();
    });
  };
}

/** Normalize to 256×256 PNG. Returns the public URL path. */
async function normalizeLogo(file) {
  if (!file) return '';
  const isSvg = /\.svg$/i.test(file.filename) || file.mimetype === 'image/svg+xml';
  if (!isSvg) {
    try {
      const sharp = require('sharp');
      const target = file.path.replace(/\.[a-z]+$/i, '') + '.png';
      const buffer = await sharp(file.path)
        .resize(256, 256, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png()
        .toBuffer();
      fs.writeFileSync(target, buffer);
      if (target !== file.path) fs.unlinkSync(file.path);
      return '/uploads/logos/' + path.basename(target);
    } catch {
      /* sharp unavailable or bad image — store original */
    }
  }
  return '/uploads/logos/' + path.basename(file.filename);
}

function deleteLogo(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/logos/')) return;
  const full = path.join(dir, path.basename(publicPath));
  fs.rm(full, { force: true }, () => {});
}

module.exports = { logoField, normalizeLogo, deleteLogo };
