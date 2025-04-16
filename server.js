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

// CORS middleware with detailed logging
app.use((req, res, next) => {
  const origin = req.headers.origin;
  console.log(`Incoming request: ${req.method} ${req.path}`);
  console.log(`Origin: ${origin}`);
  console.log(`Headers:`, req.headers);

  // Allow requests from any origin in production
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    console.log('Handling OPTIONS preflight request');
    return res.status(200).json({ message: 'CORS enabled' });
  }

  next();
});

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
    headers: req.headers
  });
});

// Initialize Firebase Admin
let serviceAccount;
try {
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SERVICE_ACCOUNT_KEY) {
      throw new Error('SERVICE_ACCOUNT_KEY environment variable is not set');
    }
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }

  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('Invalid service account configuration');
  }

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
let muxClient;
async function initializeMux() {
  try {
    if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
      console.error('Mux credentials missing:', {
        hasTokenId: !!process.env.MUX_TOKEN_ID,
        hasTokenSecret: !!process.env.MUX_TOKEN_SECRET
      });
      throw new Error('Mux credentials are not configured');
    }
    
    muxClient = new Mux(process.env.MUX_TOKEN_ID, process.env.MUX_TOKEN_SECRET);
    console.log('Mux client initialized successfully');
    
    // Test Mux connection
    const testStream = await muxClient.Video.LiveStreams.create({
      playback_policy: ['public'],
      new_asset_settings: { playback_policy: ['public'] }
    });
    console.log('Mux test stream created successfully:', testStream);
    
    // Clean up test stream
    await muxClient.Video.LiveStreams.del(testStream.id);
    console.log('Mux test stream deleted successfully');
  } catch (error) {
    console.error('Error initializing Mux client:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code
    });
    process.exit(1);
  }
}

// Initialize Mux before starting the server
initializeMux().then(() => {
  console.log('Mux initialization complete, starting server...');
}).catch(error => {
  console.error('Failed to initialize Mux:', error);
  process.exit(1);
});

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
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: process.env.NODE_ENV === 'production' ? 500 : 2000, // Increased limits
  message: JSON.stringify({ 
    error: 'Too many streaming requests',
    details: 'Please try again after 5 minutes'
  }),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many streaming requests',
      details: 'Please try again after 5 minutes',
      retryAfter: 300 // 5 minutes in seconds
    });
  }
});

const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: process.env.NODE_ENV === 'production' ? 200 : 2000, // Increased limits
  message: JSON.stringify({ 
    error: 'Too many requests',
    details: 'Please try again after 5 minutes'
  }),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      details: 'Please try again after 5 minutes',
      retryAfter: 300 // 5 minutes in seconds
    });
  }
});

// Apply rate limiting with more specific paths
app.use('/api/create-stream', streamLimiter);
app.use('/api/delete-stream', streamLimiter);
app.use('/api/streams', streamLimiter);
app.use('/api/test', apiLimiter);
app.use('/api/upload-image', apiLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Service account test endpoint
app.get('/api/test-service-account', (req, res) => {
  try {
    const serviceAccount = process.env.NODE_ENV === 'production'
      ? JSON.parse(process.env.SERVICE_ACCOUNT_KEY)
      : require('./serviceAccountKey.json');
    
    res.json({
      status: 'success',
      environment: process.env.NODE_ENV,
      hasServiceAccount: !!serviceAccount,
      projectId: serviceAccount.project_id
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
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
    const streamData = roomData.streamId ? {
      streamId: roomData.streamId,
      playbackId: roomData.playbackId,
      status: roomData.isStreaming ? 'active' : 'idle'
    } : null;

    res.json(streamData || { status: 'no_stream' });
  } catch (error) {
    console.error('Error checking stream status:', error);
    res.status(500).json({ error: 'Failed to check stream status' });
  }
});

// Test endpoint for CORS
app.get('/api/test', (req, res) => {
  console.log('Test endpoint called');
  res.json({ message: 'CORS is working!' });
});

// Enhanced error handling for stream creation
app.post('/api/create-stream', async (req, res) => {
  try {
    console.log('Create stream request received:', req.body);
    const { roomId, userId } = req.body;

    if (!roomId || !userId) {
      console.error('Missing required parameters:', { roomId, userId });
      return res.status(400).json({ error: 'Missing roomId or userId' });
    }

    if (!muxClient || !muxClient.Video) {
      console.error('Mux client not initialized:', { hasClient: !!muxClient, hasVideo: !!muxClient?.Video });
      throw new Error('Mux client not properly initialized');
    }

    console.log('Creating Mux stream with client:', {
      hasClient: !!muxClient,
      hasVideo: !!muxClient.Video,
      hasLiveStreams: !!muxClient.Video.LiveStreams
    });

    const stream = await muxClient.Video.LiveStreams.create({
      playback_policy: ['public'],
      new_asset_settings: { playback_policy: ['public'] }
    });

    console.log('Stream created successfully:', stream);
    res.json(stream);
  } catch (error) {
    console.error('Error creating stream:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code
    });
    res.status(500).json({ error: error.message });
  }
});

// Enhanced stream deletion endpoint
app.post('/api/delete-stream', async (req, res) => {
  try {
    console.log('Delete stream request received:', req.body);
    const { streamId } = req.body;

    if (!streamId) {
      console.error('Missing streamId');
      return res.status(400).json({ error: 'Missing streamId' });
    }

    if (!muxClient || !muxClient.Video) {
      throw new Error('Mux client not properly initialized');
    }

    await muxClient.Video.LiveStreams.del(streamId);
    console.log('Stream deleted successfully:', streamId);
    res.json({ message: 'Stream deleted successfully' });
  } catch (error) {
    console.error('Error deleting stream:', error);
    res.status(500).json({ error: error.message });
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