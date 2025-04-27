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
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

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
  origin: allowedOrigins,
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

// Initialize Google Generative AI


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
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY || "hYypWDeePWumugzfDdEBuRTalYxIyJG1"}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mistral-medium', // or 'mistral-small', 'mistral-large' if you have access
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
    if (data.choices && data.choices[0] && data.choices[0].message) {
      res.json({ response: data.choices[0].message.content });
    } else {
      res.status(500).json({ error: "No response from Sade AI." });
    }
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
      !/^\(If the user/i.test(line) // Remove lines like (If the user seems upset...)
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
    }
    if (reply) {
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

app.use(express.static(path.join(__dirname, '../frontend/build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

