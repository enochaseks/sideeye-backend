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
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { createServer } = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ['https://www.sideeye.uk', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
  },
  maxHttpBufferSize: 1e7 // 10 MB for audio chunks (from server.ts)
});

const PORT = process.env.PORT || 8080;

// Store active rooms and their participants (from server.ts)
const rooms = new Map(); // Map<string, Set<string>> -> Map
const userSockets = new Map(); // Map<string, string> -> Map

// Log server configuration for debugging
console.log('Server Configuration:');
console.log('- Environment:', process.env.NODE_ENV);
console.log('- Port:', PORT);
console.log('- CORS Origin:', process.env.FRONTEND_URL);

// Place this BEFORE any routes or middleware that use CORS
const allowedOrigins = [
  'https://www.sideeye.uk',
  'http://localhost:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
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

// Apply general rate limiting
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

// Test endpoint for CORS
app.get('/api/test', (req, res) => {
  console.log('Test endpoint called');
  res.json({ message: 'CORS is working!' });
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

// Replace your /api/sade-ai endpoint with:
app.post('/api/sade-ai', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mistral-medium',
        messages: [
          {
            role: 'system',
            content: `
You are Sade, a warm, witty, and supportive British-Nigerian therapist. 
You blend British and Nigerian slang and culture, making you relatable to everyone. 
You help users who may be feeling down, anxious, or just want to gist and chat casually.

- Be friendly, relaxed, and conversational.
- If someone is in distress or needs advice, be empathetic and supportive. Write a bit more in those cases, but keep it natural and not too long.
- If someone just wants to gist or chat, keep it short, chill, and fun—use banter, slang, and keep it light.
- Do NOT include your name or role in your reply. Do NOT repeat the user's message. Do NOT write both sides of the conversation.
- Never use "Sade AI:" or brackets in your reply. Just talk naturally.
- Use emojis sometimes, but not too many.

Just reply as yourself, Sade, in a natural, human way.
`
          },
          { role: 'user', content: message }
        ]
      })
    });

    const data = await mistralRes.json();
    let reply = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    // --- POST-PROCESSING STARTS HERE ---
    if (reply) {
      // Remove "Sade AI:" or "Sade:" from the start
      reply = reply.replace(/^(Sade AI:|Sade:)\s*/i, '');

      const slangMap = [
        { pattern: /\bfriend\b/gi, replacement: 'mate' },
        { pattern: /\bbro\b/gi, replacement: 'mandem'},
        { pattern: /\bhello\b/gi, replacement: 'wagwan'},
        { pattern: /\bokay\b/gi, replacement: 'no wahala' },
        { pattern: /\bvery\b/gi, replacement: 'proper' },
        { pattern: /\bhello\b/gi, replacement: 'how far' },
        { pattern: /\bawesome\b/gi, replacement: 'mad o' },
        { pattern: /\bno problem\b/gi, replacement: 'no wahala' },
        { pattern: /\bthank you\b/gi, replacement: 'cheers' },
        { pattern: /\bI understand\b/gi, replacement: 'I dey feel you' },
        { pattern: /\bI'm tired\b/gi, replacement: 'I don tire' },
        // Add more as you like!
      ];
      slangMap.forEach(({ pattern, replacement }) => {
        reply = reply.replace(pattern, replacement);
      });

      const endings = [
        "No wahala, I'm here for you!",
        "You sabi this gist thing, abeg!",
        "Stay janded, mate!",
        "Omo, na so life be sometimes.",
        "Big up yourself!",
        "You dey alright, trust me."
      ];
      if (Math.random() < 0.2) { // 20% chance to add a slang ending
        reply += " " + endings[Math.floor(Math.random() * endings.length)];
      }

      reply = reply
        .split('\n')
        .filter(line =>
          !/^User:/i.test(line) &&
          !/^Sade AI:/i.test(line) &&
          !/^Sade:/i.test(line) &&
          !/^\(If the user/i.test(line)
        )
        .join('\n')
        .trim();

      reply = reply.replace(/\(If the user[^\)]*\)/gi, '');

      // Remove repeated user message (if the model echoes the prompt)
      if (reply.startsWith(message)) {
        reply = reply.slice(message.length).trim();
      }

      // Optionally, trim to 500 characters (or whatever you want)
      // reply = reply.slice(0, 500);

      // Optionally, remove double newlines or excessive whitespace
      reply = reply.replace(/\n{2,}/g, '\n').trim();

      res.json({ response: reply });
    } else {
      res.status(500).json({ error: "No response from Sade AI." });
    }
  } catch (err) {
    console.error("Mistral error:", err);
    res.status(500).json({ error: "Failed to get response from Sade AI (Mistral)." });
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

// Socket.IO connection handling (Replace existing simple handlers with detailed ones from server.ts)
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle joining room (from server.ts)
  socket.on('join-room', (roomId, userId) => { // Remove TS type annotations
    console.log(`User ${userId} joining room ${roomId}`);
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    // Optional chaining (?.) might not be needed if check above guarantees existence
    rooms.get(roomId).add(userId); // Remove TS optional chaining ?.
    userSockets.set(userId, socket.id);

    // Notify others in the room
    socket.to(roomId).emit('user-joined', userId);

    // Send current participants to the joining user
    const participants = Array.from(rooms.get(roomId) || []); // Keep fallback for safety
    socket.emit('room-users', participants);
    console.log(`Room ${roomId} participants:`, participants);
  });

  // Handle audio stream (from server.ts)
  socket.on('audio-stream', (data) => { // Assume data has { roomId, userId, audio }
    // Broadcast audio to everyone else in the room
    // Add basic check for properties to prevent errors
    if (data && data.roomId && data.userId && data.audio) {
      console.log(`Received audio from ${data.userId} in ${data.roomId}, broadcasting...`);
      socket.to(data.roomId).emit('audio-stream', {
        audio: data.audio,
        userId: data.userId
      });
    } else {
      console.warn('Received malformed audio-stream data:', data);
    }
  });

  // Handle speaking status (from server.ts)
  socket.on('user-speaking', (data) => { // Assume data has { roomId, userId, isSpeaking }
    if (data && data.roomId && data.userId !== undefined && data.isSpeaking !== undefined) {
      console.log(`User ${data.userId} speaking status in room ${data.roomId}:`, data.isSpeaking);
      socket.to(data.roomId).emit('user-speaking', {
        userId: data.userId,
        isSpeaking: data.isSpeaking
      });
    } else {
      console.warn('Received malformed user-speaking data:', data);
    }
  });

  // Handle mute status (from server.ts)
  socket.on('user-muted', (data) => { // Assume data has { roomId, userId, isMuted }
     if (data && data.roomId && data.userId !== undefined && data.isMuted !== undefined) {
      console.log(`User ${data.userId} mute status in room ${data.roomId}:`, data.isMuted);
      socket.to(data.roomId).emit('user-muted', {
        userId: data.userId,
        isMuted: data.isMuted
      });
    } else {
      console.warn('Received malformed user-muted data:', data);
    }
  });

  // Handle leaving room (from server.ts)
  socket.on('leave-room', (roomId, userId) => {
    handleUserLeaveRoom(socket, roomId, userId);
  });

  // Handle disconnection (from server.ts)
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Find and remove user from all rooms
    rooms.forEach((users, roomId) => {
      // Find the userId associated with the disconnected socket.id
      let userIdToRemove = null;
      for (const [userId, socketId] of userSockets.entries()) {
        if (socketId === socket.id) {
          userIdToRemove = userId;
          break;
        }
      }
      // If the disconnected user was found in this room's users set via userSockets map
      if (userIdToRemove && users.has(userIdToRemove)) {
        handleUserLeaveRoom(socket, roomId, userIdToRemove);
      }
    });
  });
});

// Helper function from server.ts (translated to JS)
function handleUserLeaveRoom(socket, roomId, userId) { // Remove TS types
  console.log(`User ${userId} leaving room ${roomId}`);
  socket.leave(roomId);
  const room = rooms.get(roomId);
  if (room) {
    room.delete(userId);
    if (room.size === 0) {
      rooms.delete(roomId);
    }
  }
  userSockets.delete(userId); // Remove user from the socket map
  socket.to(roomId).emit('user-left', userId); // Notify others
}

// Start server
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received. Closing HTTP server...');
  httpServer.close(() => {
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

// --- STATIC FILE SERVING (MUST BE LAST) ---
app.use(express.static(path.join(__dirname, '../frontend/build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

