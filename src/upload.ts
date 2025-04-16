const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');
const path = require('path');
import { Request, Response, NextFunction } from 'express';

// Define custom types for multer file uploads
interface MulterRequest extends Request {
  file?: Express.Multer.File;
  files?: Express.Multer.File[];
}

// Initialize Firebase Admin
const firebaseServiceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

// Initialize Google Cloud Storage
const googleCloudServiceAccount = require('../googleCloudKey.json');
const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  credentials: googleCloudServiceAccount
});

const bucket = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET || '');

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
    upload.single(fieldName)(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      if (!req.file) {
        return next();
      }

      try {
        const fileName = `${Date.now()}-${req.file.originalname}`;
        const file = bucket.file(fileName);

        const stream = file.createWriteStream({
          metadata: {
            contentType: req.file.mimetype,
          },
        });

        stream.on('error', (err) => {
          console.error('Error uploading file:', err);
          return res.status(500).json({ error: 'Error uploading file' });
        });

        stream.on('finish', async () => {
          // Make the file public
          await file.makePublic();
          
          // Get the public URL
          const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
          
          // Add the URL to the request object
          req.body[fieldName] = publicUrl;
          next();
        });

        stream.end(req.file.buffer);
      } catch (error) {
        console.error('Error handling file upload:', error);
        return res.status(500).json({ error: 'Error handling file upload' });
      }
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