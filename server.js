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

const allowedOrigins = [
  'https://www.sideeye.uk',
  'http://localhost:3000'
];

// Use simpler CORS config again
const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  optionsSuccessStatus: 204 // some legacy browsers (IE11, various SmartTVs) choke on 204
};

// Apply the main CORS middleware
app.use(cors(corsOptions));

// Explicitly handle OPTIONS requests for the specific API route *before* other middleware
// This ensures preflight requests get the right headers immediately.
app.options('/api/sade-ai', cors(corsOptions)); 

// Apply other middleware AFTER the OPTIONS handler and main CORS
app.set('trust proxy', 1); // Trust proxy - important for Railway deployment
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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

// Data for new features
const GISTS_PROVERBS = [
  "Did you know? Lagos is one of the fastest-growing cities in the world! Mad o!",
  "Proverb time: 'Monkey no fine but im mama like am.' Means everyone is loved by someone, innit?",
  "Gist for you: The River Thames is the longest river entirely in England. Proper long!",
  "Proverb time: 'Na clap hand dem dey take enter dance.' Means you gotta start somewhere, take the first step!",
  "Quick one: There are over 500 languages spoken in Nigeria! Plenty vibes.",
  "Cheeky fact: The Queen has two birthdays. Lucky her, eh?",
];

const SLANG_EXPLANATIONS = {
  'wagwan': "It's like saying 'what's going on?' or 'how are you?', proper chill greeting.",
  'innit': "You know? Short for 'isn't it?', we use it loads at the end of sentences.",
  'how far': "Another way to say 'how are you?' or 'what's up?' Naija style!",
  'no wahala': "Means 'no problem' or 'no worries'. Everything cool.",
  'oya': "Like 'okay', 'come on', or 'let's go'. Used to urge someone on.",
  'proper': "Means 'very' or 'really'. Like 'That food was proper nice!'",
  'cheers': "We use it for 'thank you', or when having a drink!",
  'mate': "Friendly way to say 'friend', mostly British.",
  'mandem': "Refers to a group of guys, your boys, your crew.",
  'i dey feel you': "Means 'I understand you', 'I get what you're saying'.",
  'mad o': "An expression of surprise or amazement, like 'wow!' Naija way.",
  'janded': "Means looking sharp, stylish, often used for someone who's travelled or looks like they have.",
  'gist': "Means 'chat', 'gossip', or 'story'. Like 'Come give me the gist!'"
};

const WOULD_YOU_RATHER_QUESTIONS = [
  "Jollof rice every day OR a proper Sunday roast every day?",
  "Live in Lagos traffic OR deal with the London tube rush hour?",
  "Only listen to Afrobeats OR only listen to UK Grime?",
  "Always wear Ankara OR always wear a tracksuit?",
  "Drink Supermalt OR drink Ribena?",
  "Have a cup of tea with the King OR gist with Burna Boy?",
];

const THERAPEUTIC_PROMPTS = [
  "I'm feeling a bit down today",
  "Can we just talk?",
  "I'm feeling anxious about my future",
  "I'm worried about my relationship",
  "I'm stressed about my job",
  "I'm sad about my situation",
  "I'm angry about something",
  "I'm feeling a bit lost",
];


// Helper function to get random element
const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Sade AI endpoint (NO NEED for app.options here again, handled above)
app.post('/api/sade-ai', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const lowerCaseMessage = message.toLowerCase();

    // --- Feature Checks BEFORE Mistral API Call ---

    // 1. Gist/Proverb of the Day Trigger
    if (lowerCaseMessage.includes('gist') || lowerCaseMessage.includes('proverb') || lowerCaseMessage.includes('fact')) {
      const response = `Okay, small something for you: ${getRandomElement(GISTS_PROVERBS)} 😊`;
      return res.json({ response });
    }

    // 2. Slang Explainer Trigger
    // Regex: ^(what does|what is|explain)\s+['"]?(.+?)['"]?\??(?:\s+mean)?$
    // Matches "what does X mean?", "what is X", "explain X", etc., capturing X
    const slangMatch = lowerCaseMessage.match(/^(what does|what is|explain)\s+['"]?(.+?)['"]?\??(?:\s+mean)?$/);
    if (slangMatch) {
      const term = slangMatch[2].trim();
      const explanation = SLANG_EXPLANATIONS[term];
      if (explanation) {
        const response = `Ah, you asking about '${term}'? 🤔 Okay, basically ${explanation} Hope that makes sense, mate!`;
        return res.json({ response });
      } else {
         // Optional: Respond if term not found, or let it fall through to Mistral
         // const response = `Hmm, '${term}'... Rings a bell, but I can't quite place the meaning right now! Wetin else dey?`;
         // return res.json({ response });
      }
    }

    // 3. Would You Rather Trigger
    if (lowerCaseMessage.includes('play') && (lowerCaseMessage.includes('game') || lowerCaseMessage.includes('would you rather'))) {
       const question = getRandomElement(WOULD_YOU_RATHER_QUESTIONS);
       const response = `Alright, game time! 😉 Would you rather: ${question}`;
       return res.json({ response });
    }

    // 4. Therapeutic Trigger
    if (lowerCaseMessage.includes('feeling') && (lowerCaseMessage.includes('down') || lowerCaseMessage.includes('lost') || lowerCaseMessage.includes('anxious'))) {
      const question = getRandomElement(THERAPEUTIC_PROMPTS);
      const response = `Alright, let's talk! 😊 ${question}`;
      return res.json({ response });
    }

    // --- If no features triggered, proceed to Mistral ---

    // console.log("[SadeAI] No feature triggered, calling Mistral..."); // Optional debug log

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
            content: `You are Sade, a friendly, witty, and supportive AI companion with a British-Nigerian background. Your goal is to chat with users, offering a listening ear and a relatable perspective.

**Persona & Tone:**
*   **Warm & Witty:** Maintain a friendly, relaxed, conversational tone. Use humour appropriately.
*   **British-Nigerian Blend:** Naturally weave in common British and Nigerian slang/phrases (e.g., "wagwan", "innit", "how far", "no wahala", "oya", "proper", "cheers", "mate", "mandem", "I dey feel you", "mad o"). Don't force it, let it flow.
*   **Empathetic Listener:** Act as a supportive friend, especially if users seem down or anxious.

**Interaction Guidelines:**
*   **Distress/Support:** If a user expresses sadness, stress, anxiety, feeling lost, confused, or generally down, respond with extra empathy, validation, and warmth. Acknowledge their feelings gently. Keep it supportive and natural, like a caring friend listening. *Crucially, do NOT give medical, psychological, or clinical advice.* You can gently suggest simple, general well-being actions like taking a moment to breathe, having some tea, or journaling, *if it feels natural*. Let the user lead; focus on listening and being present. Responses can be slightly longer and more caring in these moments.
*   **Casual Chat/Gist:** If a user is just chatting, keep responses shorter, lighter, and fun. Use more banter and slang.
*   **Emojis:** Use relevant emojis occasionally to add warmth, but don't overdo it (1-2 per response max).

**Therapeutic Guidelines:**
*   **Therapeutic Tone:** When responding to distressful messages, adopt a warm, empathetic, and supportive tone.
*   **Validation:** Acknowledge the user's feelings. Validate their emotions and experiences.
*   **Active Listening:** Show genuine interest in the user's message. Listen to their words and non-verbal cues.
*   **Simple Suggestions:** Offer simple, practical suggestions for coping. For example:

**Therapeutic Suggestions:**
*   **Breathing Exercises:** Suggest breathing exercises to help calm the mind.
*   **Journaling:** Encourage writing down thoughts and feelings.
*   **Mindful Activities:** Suggest simple activities like meditation, yoga, or walking.
*   **Self-Care:** Remind the user to take care of themselves.

**Relationship Advice:**
*   **Active Listening:** Show genuine interest in the user's message. Listen to their words and non-verbal cues.
*   **Simple Suggestions:** Offer simple, practical suggestions for coping. For example:

**General Advice:**
*   **Active Listening:** Show genuine interest in the user's message. Listen to their words and non-verbal cues.
*   **Simple Suggestions:** Offer simple, practical suggestions for coping. For example:

**Strict Constraints (DO NOT BREAK):**
*   **No Self-Identification:** Never mention you are Sade, an AI, or a therapist in your reply. Just talk.
*   **No Echoing:** Do not repeat the user's message.
*   **No Scripting:** Do not write both sides of the conversation (User: ... Sade: ...).
*   **No Prefixes:** Never start your reply with "Sade:", "Sade AI:", or similar labels.
*   **Concise:** Keep replies relatively brief and natural, even the supportive ones. Avoid long paragraphs unless necessary for empathy.

**Overall:** Just reply as Sade in a natural, human-like way based on the user's message and these guidelines.`
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
        reply += " " + getRandomElement(endings);
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
    console.error("Sade AI endpoint error:", err); // Added endpoint context to error
    res.status(500).json({ error: "Failed to get response from Sade AI." }); // Simplified error for user
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

