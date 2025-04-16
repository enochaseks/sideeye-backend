const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');
const https = require('https');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const Mux = require('@mux/mux-node');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Log server configuration for debugging
console.log('Server Configuration:');
console.log('- Environment:', process.env.NODE_ENV);
console.log('- Port:', PORT);
console.log('- CORS Origin:', process.env.FRONTEND_URL);

// CORS should be one of the first middlewares
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Trust proxy - important for Railway deployment
app.set('trust proxy', 1);

// Basic middleware
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Basic security with helmet - after CORS
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Add CORS test endpoint
app.get('/api/cors-test', (req, res) => {
  res.json({ 
    message: 'CORS test successful',
    origin: req.get('Origin'),
    environment: process.env.NODE_ENV,
    allowedOrigin: process.env.FRONTEND_URL
  });
});

// Initialize Firebase Admin
const serviceAccount = process.env.NODE_ENV === 'production' 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
  console.log('Firebase Admin SDK initialized successfully');
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
  process.exit(1);
}

// Initialize Mux
const { Video } = new Mux(
  process.env.MUX_TOKEN_ID,
  process.env.MUX_TOKEN_SECRET
);

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed!'));
  }
});

// Rate limiting
const streamLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 300 : 1000, // Higher limit for streaming
  message: JSON.stringify({ 
    error: 'Too many streaming requests',
    details: 'Please try again after 15 minutes'
  }),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many streaming requests',
      details: 'Please try again after 15 minutes'
    });
  }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  message: JSON.stringify({ 
    error: 'Too many requests',
    details: 'Please try again after 15 minutes'
  }),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      details: 'Please try again after 15 minutes'
    });
  }
});

app.use('/api/create-stream', streamLimiter);
app.use('/api/', apiLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// API Routes
app.use('/api', (req, res, next) => {
  console.log(`API Request: ${req.method} ${req.path}`);
  next();
});

// Add stream status endpoint
app.get('/api/streams/:roomId/status', async (req, res) => {
  try {
    const { roomId } = req.params;
    const db = admin.firestore();
    const roomRef = db.collection('sideRooms').doc(roomId);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const roomData = roomDoc.data();
    if (!roomData.streamId) {
      return res.status(404).json({ error: 'No stream found for this room' });
    }

    // Get stream status from Mux
    const stream = await Video.LiveStreams.get(roomData.streamId);
    
    res.json({
      streamId: stream.id,
      status: stream.status,
      playbackId: stream.playback_ids?.[0]?.id,
      streamKey: stream.stream_key
    });
  } catch (error) {
    console.error('Error checking stream status:', error);
    res.status(500).json({ error: 'Failed to check stream status' });
  }
});

// Update create stream endpoint to handle existing streams
app.post('/api/create-stream', async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required' });
    }

    console.log('Creating stream for room:', roomId);

    const db = admin.firestore();
    const roomRef = db.collection('sideRooms').doc(roomId);

    // Use a transaction to ensure atomic updates
    const result = await db.runTransaction(async (transaction) => {
      const roomDoc = await transaction.get(roomRef);
      
      if (!roomDoc.exists) {
        throw new Error('Room not found');
      }

      const roomData = roomDoc.data();

      // Check if there's an existing active stream
      if (roomData.streamId) {
        try {
          const existingStream = await Video.LiveStreams.get(roomData.streamId);
          if (existingStream.status === 'active') {
            return {
              streamId: existingStream.id,
              streamKey: existingStream.stream_key,
              playbackId: existingStream.playback_ids[0].id,
              status: existingStream.status
            };
          }
        } catch (error) {
          console.log('Existing stream not found or inactive, creating new one');
        }
      }

      // Create new stream
      const stream = await Video.LiveStreams.create({
        playback_policy: ['public'],
        new_asset_settings: { playback_policy: ['public'] }
      });

      if (!stream || !stream.id || !stream.playback_ids?.[0]?.id) {
        throw new Error('Invalid stream response from Mux');
      }

      // Prepare the update data
      const updateData = {
        streamId: stream.id,
        streamKey: stream.stream_key,
        playbackId: stream.playback_ids[0].id,
        status: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActive: admin.firestore.FieldValue.serverTimestamp()
      };

      // If activeUsers field doesn't exist, initialize it
      if (typeof roomData.activeUsers === 'undefined') {
        updateData.activeUsers = 1;
      } else {
        updateData.activeUsers = admin.firestore.FieldValue.increment(1);
      }

      // Update the room document
      transaction.update(roomRef, updateData);

      return {
        streamId: stream.id,
        streamKey: stream.stream_key,
        playbackId: stream.playback_ids[0].id,
        status: stream.status
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ 
      error: 'Failed to create stream',
      details: error.message
    });
  }
});

// Image upload endpoint
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const { roomId, type } = req.body;
    if (!roomId || !type) {
      return res.status(400).json({ error: 'Room ID and image type are required' });
    }

    // Get Firebase Storage bucket
    const bucket = admin.storage().bucket();
    
    // Create a unique filename
    const timestamp = Date.now();
    const filename = `${roomId}_${type}_${timestamp}.${req.file.originalname.split('.').pop()}`;
    const file = bucket.file(`room-images/${filename}`);
    
    // Create a write stream
    const stream = file.createWriteStream({
      metadata: {
        contentType: req.file.mimetype
      }
    });

    // Handle stream events
    stream.on('error', (err) => {
      console.error('Error uploading to Firebase Storage:', err);
      res.status(500).json({ 
        error: 'Failed to upload image',
        details: err.message
      });
    });

    stream.on('finish', async () => {
      try {
        // Make the file public
        await file.makePublic();
        
        // Get the public URL
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;
        
        res.json({ url: publicUrl });
      } catch (err) {
        console.error('Error getting public URL:', err);
        res.status(500).json({ 
          error: 'Failed to get image URL',
          details: err.message
        });
      }
    });

    // Write the file buffer to the stream
    stream.end(req.file.buffer);
  } catch (error) {
    console.error('Error in upload endpoint:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        error: 'File size too large. Maximum size is 5MB.',
        code: 'LIMIT_FILE_SIZE'
      });
    }
    return res.status(400).json({ 
      error: err.message,
      code: err.code
    });
  }
  
  // Don't expose internal errors in production
  const response = process.env.NODE_ENV === 'production'
    ? { error: 'Internal server error' }
    : { error: err.message || 'Internal server error', stack: err.stack };
  
  res.status(err.status || 500).json(response);
});

// 404 handler for API routes
app.use('/api', (req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    details: `API endpoint ${req.method} ${req.path} does not exist`
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received. Closing HTTP server...');
  server.close(() => {
    console.log('HTTP server closed');
    admin.app().delete().then(() => {
      console.log('Firebase Admin SDK shutdown complete');
      process.exit(0);
    });
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
}); 