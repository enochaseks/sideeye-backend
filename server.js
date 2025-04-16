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
const PORT = process.env.PORT || 3001;

// Production security configurations
if (process.env.NODE_ENV === 'production') {
  // Trust proxy if behind reverse proxy
  app.set('trust proxy', 1);
  
  // Security headers
  app.use(helmet());
  
  // Production CORS configuration
  const corsOptions = {
    origin: process.env.FRONTEND_URL || 'https://sideeye.uk',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400 // 24 hours
  };
  app.use(cors(corsOptions));
} else {
  app.use(cors());
}

// Compression middleware
app.use(compression());

// Request logging
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}

// Body parser middleware with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialize Firebase Admin
const serviceAccount = process.env.NODE_ENV === 'production' 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  httpAgent: new https.Agent({
    keepAlive: true,
    maxSockets: 25,
    timeout: 30000 // 30 seconds
  }),
  retryConfig: {
    maxRetries: 3,
    backoffFactor: 1.5
  }
});

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
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use('/api/', apiLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.post('/api/create-stream', async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required' });
    }

    const muxTokenId = process.env.MUX_TOKEN_ID;
    const muxTokenSecret = process.env.MUX_TOKEN_SECRET;

    if (!muxTokenId || !muxTokenSecret) {
      console.error('Mux credentials not configured');
      return res.status(500).json({ 
        error: 'Stream service not configured',
        details: 'Mux credentials are missing'
      });
    }

    console.log('Creating stream with Mux credentials:', {
      tokenId: muxTokenId,
      tokenSecret: muxTokenSecret ? '***' : undefined
    });

    const mux = new Mux(muxTokenId, muxTokenSecret);
    
    try {
      const stream = await mux.Video.LiveStreams.create({
        playback_policy: ['public'],
        new_asset_settings: {
          playback_policy: ['public']
        }
      });

      if (!stream || !stream.id || !stream.playback_ids?.[0]?.id) {
        throw new Error('Invalid stream response from Mux');
      }

      // Store the stream ID in Firestore
      const db = getFirestore();
      await setDoc(doc(db, 'sideRooms', roomId), {
        streamId: stream.id,
        streamKey: stream.stream_key,
        playbackId: stream.playback_ids[0].id,
        status: 'active',
        updatedAt: new Date()
      }, { merge: true });

      // Send both streamId and streamKey in the response
      res.json({
        streamId: stream.id,
        streamKey: stream.stream_key,
        playbackId: stream.playback_ids[0].id,
        status: stream.status
      });
    } catch (muxError) {
      console.error('Mux API Error:', {
        message: muxError.message,
        type: muxError.type,
        status: muxError.status,
        code: muxError.code,
        details: muxError.details
      });
      
      if (muxError.type === 'unauthorized') {
        return res.status(401).json({ 
          error: 'Mux authentication failed',
          details: 'Please check your Mux API credentials'
        });
      }
      
      res.status(500).json({ 
        error: 'Failed to create stream',
        details: muxError.message || 'Unknown Mux API error'
      });
    }
  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred'
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const server = app.listen(PORT, () => {
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