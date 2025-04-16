const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG and GIF are allowed.'));
    }
  }
});

// Middleware to handle file uploads
exports.handleFileUpload = (fieldName) => {
  return (req, res, next) => {
    console.log('Starting file upload process...');
    upload.single(fieldName)(req, res, async (err) => {
      if (err) {
        console.error('Multer error:', err);
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  };
};

// Middleware to handle multiple file uploads
exports.handleMultipleFileUpload = (fieldName, maxCount = 5) => {
  return (req, res, next) => {
    upload.array(fieldName, maxCount)(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      if (!req.files || !Array.isArray(req.files)) {
        return next();
      }

      try {
        const uploadPromises = req.files.map(async (file) => {
          const fileName = `${Date.now()}-${file.originalname}`;
          const bucketFile = bucket.file(fileName);

          const stream = bucketFile.createWriteStream({
            metadata: {
              contentType: file.mimetype,
            },
          });

          return new Promise((resolve, reject) => {
            stream.on('error', reject);
            stream.on('finish', async () => {
              await bucketFile.makePublic();
              const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
              resolve(publicUrl);
            });
            stream.end(file.buffer);
          });
        });

        const urls = await Promise.all(uploadPromises);
        req.body[fieldName] = urls;
        next();
      } catch (error) {
        console.error('Error handling multiple file uploads:', error);
        return res.status(500).json({ error: 'Error handling multiple file uploads' });
      }
    });
  };
}; 