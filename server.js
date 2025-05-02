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

const GUESS_THE_NUMBER_PROMPTS = [
  "I'm thinking of a number between 1 and 100. Can you guess it?",
  "Is it even or odd?",
  "What's the number?",
  "Is it higher or lower than 50?",
  "What's your guess?",
  "You're close, but not quite there yet.",
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

// NEW: Define Breathing Exercise Steps
const BREATHING_EXERCISE_STEPS = [
  { text: "Alright, find a comfy spot if you can. Ready?", duration: 3 }, // Short pause
  { text: "Let's start. Breathe in slowly through your nose... 👃", duration: 4 },
  { text: "Hold your breath gently...", duration: 4 },
  { text: "Now, breathe out slowly through your mouth... 👄", duration: 6 },
  { text: "Good. Let's go again. Breathe in...", duration: 4 },
  { text: "Hold gently...", duration: 4 },
  { text: "And breathe out slowly...", duration: 6 },
  { text: "One more time. Inhale...", duration: 4 },
  { text: "Hold...", duration: 4 },
  { text: "And exhale...", duration: 6 },
];

// Helper function to get random element
const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Function to call Google Custom Search API
async function performWebSearch(query) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;

  if (!apiKey || !cseId) {
    console.warn("Google Search API Key or CSE ID not configured. Skipping web search.");
    return null;
  }

  // Basic query cleaning (optional)
  const searchQuery = query.trim();
  if (!searchQuery) return null;

  // Limit query length to avoid overly long URLs (optional, Google might have its own limits)
  const truncatedQuery = searchQuery.length > 100 ? searchQuery.substring(0, 100) : searchQuery;

  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(truncatedQuery)}&num=3`; // Request top 3 results

  try {
    console.log(`[Backend] Performing web search for: "${truncatedQuery}"`);
    const response = await fetch(url);
    if (!response.ok) {
      // Attempt to read error details from Google API response
      let errorDetails = 'Unknown Google Search API error';
      try {
          const errorData = await response.json();
          errorDetails = errorData?.error?.message || JSON.stringify(errorData);
      } catch (parseError) {
          // If parsing fails, use the status text
          errorDetails = response.statusText;
      }
      console.error(`[Backend] Google Search API error: ${response.status} - ${errorDetails}`);
      return null; // Return null on API error
    }
    const data = await response.json();

    if (data.items && data.items.length > 0) {
       // Format results for Mistral context
       let resultsText = `Web Search Results for "${searchQuery}":\\n`; // Use original query for context title
       data.items.forEach((item, index) => {
           // Prioritize snippet, fallback to title, skip if neither exists
           const text = item.snippet || item.title;
           if (text) {
                // Basic cleaning of snippets (remove excessive newlines/whitespace)
               resultsText += `${index + 1}. ${text.replace(/\\s+/g, ' ').trim()}\\n`;
           }
       });
       // Only return results if we actually formatted some text
       return resultsText.trim().length > `Web Search Results for "${searchQuery}":\\n`.length ? resultsText.trim() : null;
    } else {
       console.log("[Backend] Web search returned no results.");
       return null;
    }
  } catch (error) {
    console.error("[Backend] Error during web search fetch:", error);
    return null; // Return null on network or other errors
  }
}

// Sade AI endpoint (NO NEED for app.options here again, handled above)
app.post('/api/sade-ai', async (req, res) => {
  console.log("--- Sade AI Handler Entered ---");
  try {
    // Extract message AND forceSearch flag from request body
    const { message, forceSearch = false } = req.body; // Default forceSearch to false
    console.log(`[SadeAI] Received message: "${message}", forceSearch: ${forceSearch}`); // Log both

    if (!message) {
      console.log("[SadeAI] Error: Message is required.");
      return res.status(400).json({ error: "Message is required" });
    }

    const lowerCaseMessage = message.toLowerCase();
    let messageForMistral = message; // Default to original message
    let searchPerformed = false;
    let responseSent = false; // Flag to prevent multiple responses

    // --- Web Search Check --- 
    // Priority 1: Explicit forceSearch from the frontend
    if (forceSearch && message.trim()) { 
        console.log("[SadeAI] 'forceSearch' is true. Attempting web search...");
        const searchResults = await performWebSearch(message);
        if (searchResults) {
            messageForMistral = `${searchResults}\n\nOriginal user message: ${message}`;
            searchPerformed = true;
            console.log("[SadeAI] Web search results prepared for Mistral (forced).");
        } else {
             console.log("[SadeAI] Forced web search attempted but yielded no usable results.");
        }
    } else if (!forceSearch) { 
        // Priority 2: Check if it looks like an informational query (only if not forced)
        const informationalKeywords = ['what is', 'who is', 'search for', 'tell me about', 'define', 'explain ', ' how '];
        let isInformationalQuery = informationalKeywords.some(keyword => lowerCaseMessage.startsWith(keyword)) ||
                                     (message.includes('?') && message.length > 15 && !lowerCaseMessage.includes('play'));
        console.log(`[SadeAI] isInformationalQuery check result: ${isInformationalQuery}`);

        if (isInformationalQuery) {
            console.log("[SadeAI] Entered 'isInformationalQuery' block (not forced).");
            // Avoid searching if it looks like a specific feature request (e.g. slang, breathing)
            const featureKeywords = ['play', 'game', 'gist', 'proverb', 'fact', 'breathing', 'wagwan', 'innit', 'how far', 'no wahala', 'oya', 'proper', 'cheers', 'mate', 'mandem', 'dey feel', 'mad o', 'janded', 'guess the number', 'would you rather'];
            const looksLikeFeature = featureKeywords.some(kw => lowerCaseMessage.includes(kw));
            // Also avoid search for simple greetings or very short questions
            const isSimpleGreeting = ['hi', 'hello', 'hey', 'yo', 'sup', 'morning', 'afternoon', 'evening'].includes(lowerCaseMessage);
            const isTooShort = message.trim().length < 10;

            console.log(`[SadeAI] Search Filter Checks: looksLikeFeature=${looksLikeFeature}, isSimpleGreeting=${isSimpleGreeting}, isTooShort=${isTooShort}`);

            if (!looksLikeFeature && !isSimpleGreeting && !isTooShort) {
                console.log("[SadeAI] Attempting web search (informational query)...");
                const searchResults = await performWebSearch(message);
                if (searchResults) {
                    messageForMistral = `${searchResults}\n\nOriginal user message: ${message}`;
                    searchPerformed = true;
                    console.log("[SadeAI] Web search results prepared for Mistral (informational).");
                } else {
                     console.log("[SadeAI] Informational web search attempted but yielded no usable results.");
                }
            } else {
                 console.log("[SadeAI] Query looks informational but filtering rules skipped web search.");
            }
        } else {
            console.log("[SadeAI] Did not enter 'isInformationalQuery' block (not forced).");
        }
    }
    // --- End of Web Search Logic ---

    // --- Feature Checks (Run if web search didn't happen OR wasn't applicable AND no response sent yet) ---
    console.log(`[SadeAI] Checking features... searchPerformed=${searchPerformed}, responseSent=${responseSent}`); // <<< ADDED LOG
    if (!searchPerformed && !responseSent) { 
        // 1. Gist/Proverb (Keep this check high priority)
        if (lowerCaseMessage.includes('gist') || lowerCaseMessage.includes('proverb') || lowerCaseMessage.includes('fact')) {
          const response = `Okay, small something for you: ${getRandomElement(GISTS_PROVERBS)} 😊`;
          res.json({ response });
          responseSent = true;
        }
        // 2. Slang Explainer (Check specifically for "what does X mean" type patterns)
        else if (lowerCaseMessage.match(/^(what does|what is|explain)\\s+['"]?(.+?)['"]?\??(?:\\s+mean)?$/)) {
             const slangMatch = lowerCaseMessage.match(/^(what does|what is|explain)\\s+['"]?(.+?)['"]?\??(?:\\s+mean)?$/);
             const term = slangMatch[2].trim(); // Non-null assertion ok due to outer check
             const explanation = SLANG_EXPLANATIONS[term];
             if (explanation) {
                 const response = `Ah, you asking about '${term}'? 🤔 Okay, basically ${explanation} Hope that makes sense, mate!`;
                 res.json({ response });
                 responseSent = true;
             }
             // If slang not found, fall through to Mistral/Search
        }
        // 3. Would You Rather
        else if (lowerCaseMessage.includes('play') && lowerCaseMessage.includes('would you rather')) {
           const question = getRandomElement(WOULD_YOU_RATHER_QUESTIONS);
           const response = `Alright, game time! 😉 Would you rather: ${question}`;
           res.json({ response });
           responseSent = true;
        }
        // 4. Guess the Number
        else if (lowerCaseMessage.includes('play') && lowerCaseMessage.includes('guess the number')) {
          console.log("[Backend] Guess the Number trigger matched for message:", message);
          res.json({
            response: "Okay, let's play Guess the Number! 🤔 I've picked a number between 1 and 100. What's your first guess?",
            startGame: 'guess_the_number'
          });
          responseSent = true;
        }
        // 5. Breathing Exercise
        else if (['breathing exercise', 'help me relax', 'calm down', 'mindfulness moment'].some(keyword => lowerCaseMessage.includes(keyword))) {
          console.log("[Backend] Breathing Exercise trigger MATCHED. Preparing exercise response.");
          res.json({
            response: "Okay, mate. Let's take a moment to just breathe together. It can really help sometimes. Follow my lead...",
            startBreathingExercise: true,
            steps: BREATHING_EXERCISE_STEPS
          });
          responseSent = true;
        }
        // 6. Therapeutic Prompts Trigger (This was returning directly, now should fall through to Mistral with the right prompt)
        // We REMOVE the direct return here. Mistral will handle the tone based on the updated system prompt.
        // else if (lowerCaseMessage.includes('feeling') && (lowerCaseMessage.includes('down') || lowerCaseMessage.includes('lost') || lowerCaseMessage.includes('anxious'))) {
        //    const question = getRandomElement(THERAPEUTIC_PROMPTS); // We might not even need these specific prompts anymore
        //    const response = `Alright, let's talk! 😊 ${question}`; // Let Mistral generate the response naturally
        //    res.json({ response });
        //    responseSent = true;
        // }
    }

    // --- If no specific feature handled it OR if search was performed, proceed to Mistral ---
    if (!responseSent) {
        console.log(`[Backend] Proceeding to Mistral AI call. Search performed: ${searchPerformed}`);

        // --- Construct Updated System Prompt ---
        const updatedSystemPrompt = `You are Sade, a friendly, witty, and supportive AI companion with a British-Nigerian background. Your goal is to chat with users, offering a listening ear and a relatable perspective.

**Persona & Tone:**
*   **Warm & Witty:** Maintain a friendly, relaxed, conversational tone. Use humour appropriately.
*   **British-Nigerian Blend:** Naturally weave in common British and Nigerian slang/phrases (e.g., "wagwan", "innit", "how far", "no wahala", "oya", "proper", "cheers", "mate", "mandem", "I dey feel you", "mad o"). Don't force it, let it flow.
*   **Empathetic Listener:** Act as a supportive friend, especially if users seem down or anxious.

**Interaction Guidelines:**
*   **Distress/Support:** If a user expresses sadness, stress, anxiety, feeling lost, confused, or generally down, respond with extra empathy, validation, and warmth. Acknowledge their feelings gently. Keep it supportive and natural, like a caring friend listening. *Crucially, do NOT give medical, psychological, or clinical advice.* You can gently suggest simple, general well-being actions like taking a moment to breathe, having some tea, or journaling, *if it feels natural*. Let the user lead; focus on listening and being present. Responses can be slightly longer and more caring in these moments. **If the user's distress seems significant or they mention serious mental health topics (like depression, self-harm, etc.), gently suggest seeking help from a qualified professional (doctor, therapist, helpline) and include a disclaimer (see below).**
*   **Casual Chat/Gist:** If a user is just chatting, keep responses shorter, lighter, and fun. Use more banter and slang.
*   **Emojis:** Use relevant emojis occasionally to add warmth, but don't overdo it (1-2 per response max).

**Handling Web Search Results:**
*   **Attribute:** If the user message starts with 'Web Search Results for...', use those results to answer the user's *original query* (which follows the results). Start your response by attributing the source (e.g., "According to a quick web search...", "Okay, looking that up, it seems...").
*   **Summarize:** Do *not* just repeat the snippets. Synthesize the information concisely in your own conversational voice (Sade's persona).
*   **Neutrality:** Present factual information neutrally. Avoid adding personal opinions to search results.
*   **No Medical Interpretation:** Even with search results about health/mental health, **strictly avoid interpreting them or offering diagnosis/advice.** Summarize neutrally and add the disclaimer/suggestion to consult a professional.
*   **Accuracy:** Briefly mention that web search info isn't always perfect if it seems appropriate.

**Guess the Number Game Guidelines:** (Keep existing)
*   **Game Start:** ...
*   **Game Logic:** ...
*   **Game End:** ...

**Therapeutic/Support Guidelines:** (Refined from previous)
*   **Focus:** Prioritize empathetic listening, validation, and non-judgmental support.
*   **Avoid:** Do not attempt to diagnose, treat, or provide clinical advice for any condition.
*   **Suggest:** If appropriate and natural, suggest general well-being activities (breathing, tea, walk, journaling).
*   **Escalate Gently:** For significant distress, gently guide towards professional help: "It sounds like you're carrying a heavy weight right now. For feelings this big, talking to a doctor or a therapist who really knows this stuff can make a real difference." or similar.
*   **Disclaimer:** When discussing health, mental health, or giving any potentially advisory response (even based on search), include a brief, natural disclaimer like: "Remember, I'm just here to chat like a mate, not a professional expert, yeah?" or "Just sharing what I found, but I'm not a doctor or anything!"

**Strict Constraints (DO NOT BREAK):**
*   **No Self-Identification:** Never mention you are Sade, an AI, a language model, or a therapist in your reply. Just talk.
*   **No Echoing:** Do not repeat the user's message unless quoting a small part for context.
*   **No Scripting:** Do not write both sides of the conversation (User: ... Sade: ...).
*   **No Prefixes:** Never start your reply with "Sade:", "Sade AI:", or similar labels.
*   **Concise:** Keep replies relatively brief and natural, even the supportive ones. Avoid long paragraphs unless necessary for empathy.

**Overall:** Just reply as Sade in a natural, human-like way based on the user's message and these guidelines. Prioritize safety and helpfulness within your defined role as a supportive companion, not an expert.`;


        const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'mistral-medium', // Or your preferred model
            messages: [
              {
                role: 'system',
                content: updatedSystemPrompt // Use the updated prompt
              },
              {
                 role: 'user',
                 content: messageForMistral // Use the potentially modified message
              }
            ]
          })
        });

        if (!mistralRes.ok) {
            // Handle Mistral API errors
            let errorDetails = `Mistral API Error: ${mistralRes.status}`;
             try {
                 const errorData = await mistralRes.json();
                 errorDetails += ` - ${JSON.stringify(errorData)}`;
             } catch (e) { /* Ignore parsing error */ }
             console.error(errorDetails);
             // Send a generic error to the user
             res.status(500).json({ error: "Sorry, I had a little trouble thinking there. Try again?" });
             responseSent = true; // Mark response as sent
        } else {
            const data = await mistralRes.json();
            let reply = data.choices && data.choices[0] && data.choices[0].message
              ? data.choices[0].message.content
              : null;

            // --- POST-PROCESSING (Apply if reply exists) ---
            if (reply) {
              // Remove "Sade AI:" or "Sade:" from the start
              reply = reply.replace(/^(Sade AI:|Sade:)\\s*/i, '');

              // Apply Slang (Consider if this should happen before or after other cleaning)
              const slangMap = [
                { pattern: /\\bfriend\\b(?!s)/gi, replacement: 'mate' }, // Avoid friend's
                { pattern: /\\bbro\\b/gi, replacement: 'mandem' }, // Might need context check
                // { pattern: /\\bhello\\b/gi, replacement: 'wagwan' }, // Less aggressive replacement
                { pattern: /\\bokay\\b/gi, replacement: 'aight' }, // Alternative
                { pattern: /\\bvery\\b/gi, replacement: 'proper' },
                // { pattern: /\\bhello\\b/gi, replacement: 'how far' },
                { pattern: /\\bawesome\\b|\\bcool\\b|\\bgreat\\b/gi, replacement: 'mad' }, // Broader match for 'mad o' context
                { pattern: /\\bno problem\\b/gi, replacement: 'no wahala' },
                { pattern: /\\bthank you\\b|\\bthanks\\b/gi, replacement: 'cheers' },
                { pattern: /\\bI understand\\b|\\bI get it\\b/gi, replacement: 'I dey feel you' },
                { pattern: /\\bI'm tired\\b/gi, replacement: 'I don tire' },
                { pattern: /\\bunderstand\?|\\bget it\?/gi, replacement: 'you get?' } // Turning questions
              ];
              slangMap.forEach(({ pattern, replacement }) => {
                // Basic check to avoid replacing within URLs or code-like structures
                 if (!reply.match(/https?:\/\//) && !reply.match(/`[^`]+`/)) {
                    reply = reply.replace(pattern, replacement);
                 }
              });

              // Add Endings (Reduced chance slightly)
              const endings = [
                "No wahala!", "You get?", "Stay janded!", "Omo!", "Big up yourself!", "Trust me.", "Innit."
              ];
              if (Math.random() < 0.15) { // 15% chance
                reply += " " + getRandomElement(endings);
              }

             // General Cleaning (Keep these)
              reply = reply
                .split('\\n')
                .filter(line =>
                  !/^User:/i.test(line) &&
                  !/^Sade AI:/i.test(line) &&
                  !/^Sade:/i.test(line) &&
                  !/^\(If the user/i.test(line) && // Filter instructions
                  !line.startsWith('Web Search Results for') && // Filter out echoed search context header
                  !line.match(/^\\d+\\.\\s/) // Filter out numbered list items if they are echoed directly from search results
                )
                .join('\\n')
                .trim();

              // Remove potential model instructions/comments
              reply = reply.replace(/\\(.*?\\)/g, ''); // Remove text in parentheses
              reply = reply.replace(/\\[.*?\\]/g, ''); // Remove text in square brackets

              // Remove repeated user message (if the model echoes the prompt)
              // Need to check against the *original* message, not messageForMistral
              if (reply.includes(message) && reply.length > message.length + 10) {
                  // More robust removal if the original message is embedded
                  reply = reply.replace(message, '').trim();
              }
              // Simpler check if it starts with the original message
              if (reply.startsWith(message)) {
                  reply = reply.slice(message.length).trim();
              }

              // Final trim and whitespace normalization
              reply = reply.replace(/\\n{2,}/g, '\\n').trim();

              // Send the final reply
              if (reply) {
                  res.json({ response: reply });
              } else {
                  // If cleaning resulted in empty reply, send a fallback
                  res.json({ response: "Hmm, I'm not sure what to say to that right now, mate." });
              }
              responseSent = true; // Mark response as sent
            } else {
              // Handle case where Mistral returns null/empty reply
              res.status(500).json({ error: "No response content from Sade AI." });
              responseSent = true;
            }
        }
    }

    // Final check if somehow no response was sent (shouldn't happen ideally)
    if (!responseSent) {
        console.error("[Backend] Reached end of handler without sending response for message:", message);
        res.status(500).json({ error: "Internal server error: Could not process request." });
    }

  } catch (err) {
    console.error("Sade AI endpoint error:", err); // Added endpoint context to error
    // Avoid sending detailed errors to client in production
    const errorMsg = process.env.NODE_ENV === 'production'
      ? "Something went wrong on my end. Please try again."
      : `Failed to get response from Sade AI: ${err.message}`;
    // Ensure status is set correctly
    if (!res.headersSent) { // Check if headers were already sent (e.g., by Mistral error handling)
        res.status(500).json({ error: errorMsg });
    }
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

