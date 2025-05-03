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
const { FieldValue } = require('firebase-admin/firestore');
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
let db; // Declare db variable here, outside the try block

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
  // Get Firestore database instance and assign it
  db = admin.firestore(); 
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

const REPORT_ISSUE_GUIDE = [
  "Click the three lines at the top of the page, then click Settings, scroll down and find the 'Report an Issue' option. That page will guide you through the steps. Stay safe, yeah?",
  "If you are being harrassed or abused, please contact support at support@sideeye.uk or click the three lines at the top of the page, then click Settings, scroll down and find the 'Report an Issue' option. That page will guide you through the steps.",
  "If you are having issues with the app, please contact support at support@sideeye.uk or click the three lines at the top of the page, then click Settings, scroll down and find the 'Report an Issue' option. That page will guide you through the steps."
];

const ABUSIVE_BEHAVIOUR_GUIDE = [
  "Please do not send messages that can be interpreted as abuse or harassment towards me. This includes but is not limited to: hate speech, racism, sexism, homophobia, transphobia, ableism, body shaming, or any form of discrimination.",
  "If you continue to send abusive messages, I will stop responding to your messages and block you from responding to the chat.",
  "If you continue with that language, I will stop responding to your messages and block you from responding to the chat." 
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
    // Extract message, forceSearch flag, and userId from request body
    // We no longer primarily rely on history from the client, will fetch from DB
    const { message, forceSearch = false, userId } = req.body;
    console.log(`[SadeAI] Received message: "${message}", forceSearch: ${forceSearch}, userId: ${userId}`);

    if (!message) {
      console.log("[SadeAI] Error: Message is required.");
      return res.status(400).json({ error: "Message is required" });
    }
    if (!userId) {
      console.log("[SadeAI] Error: User ID is required for history.");
      // Decide how to handle - maybe respond without history or return error
      return res.status(400).json({ error: "User identification failed." });
    }

    let searchPerformed = false;
    let responseSent = false; // Flag to prevent multiple responses

    // --- Specific Question Checks (Hardcoded Responses) ---
    const lowerCaseMsg = message.toLowerCase();

    // Check for name question
    if (lowerCaseMsg.includes('what') && lowerCaseMsg.includes('your name')) {
        console.log("[SadeAI] Handling 'what is your name?' directly.");
        res.json({ response: "You can call me Sade! It's nice to chat with you, mate. 😊" });
        responseSent = true;
    }
    // Check for memory question
    else if (lowerCaseMsg.includes('remember') && (lowerCaseMsg.includes('conversation') || lowerCaseMsg.includes('chat') || lowerCaseMsg.includes('talk about'))) {
        console.log("[SadeAI] Handling 'do you remember?' directly.");
        res.json({ response: "Yeah, I keep track of our recent chat history to help keep the conversation flowing smoothly! What's on your mind? 🤔" });
        responseSent = true;
    }
    // --- End Specific Question Checks ---

    // --- Firestore Chat History Setup (Only run if no hardcoded response sent) ---
    let limitedFirestoreHistory = []; // Initialize here
    if (!responseSent) { // Only fetch history if we didn't send a hardcoded response
        const chatHistoryLimit = 50; // Max messages to store per user (used later)
        const historyToFetch = 30; // Max messages to fetch for Mistral context
        const chatRef = db.collection('sadeChats').doc(userId);
        let firestoreHistory = [];

        try {
            const chatDoc = await chatRef.get();
            if (chatDoc.exists) {
                const data = chatDoc.data();
                // Ensure messages field exists and is an array
                if (data && Array.isArray(data.messages)) {
                    firestoreHistory = data.messages;
                    console.log(`[SadeAI] Fetched ${firestoreHistory.length} messages from Firestore for user ${userId}.`);
                } else {
                    console.log(`[SadeAI] Firestore doc exists for ${userId}, but 'messages' field is missing or not an array.`);
                }
            } else {
                console.log(`[SadeAI] No existing Firestore chat history found for user ${userId}.`);
            }
        } catch (dbError) {
            console.error(`[SadeAI] Error fetching chat history from Firestore for user ${userId}:`, dbError);
            firestoreHistory = []; // Proceed without history on error
        }
        // Limit the history fetched for the context window
        limitedFirestoreHistory = firestoreHistory.slice(-historyToFetch);
        console.log(`[SadeAI] Using last ${limitedFirestoreHistory.length} messages from Firestore for context.`);
    }
    // -------------------------------------

    const lowerCaseMessage = message.toLowerCase();
    let webSearchResultsContext = null; // Store potential search results separately

    // --- Web Search Check (Only run if no hardcoded response sent) ---
    if (!responseSent && forceSearch && message.trim()) { 
        console.log("[SadeAI] 'forceSearch' is true. Attempting web search...");
        const searchResults = await performWebSearch(message);
        if (searchResults) {
            // Store results, don't modify message directly yet
            webSearchResultsContext = searchResults;
            searchPerformed = true;
            console.log("[SadeAI] Web search results obtained (forced).");
        } else {
             console.log("[SadeAI] Forced web search attempted but yielded no usable results.");
        }
    } else if (!responseSent && !forceSearch) { // Only run if no hardcoded response sent
        // Priority 2: Check if it looks like an informational query (only if not forced)
        const informationalKeywords = ['what is', 'who is', 'search for', 'tell me about', 'define', 'explain ', ' how '];
        let isInformationalQuery = informationalKeywords.some(keyword => lowerCaseMessage.startsWith(keyword)) ||
                                     (message.includes('?') && message.length > 15 && !lowerCaseMessage.includes('play'));
        console.log(`[SadeAI] isInformationalQuery check result: ${isInformationalQuery}`);

        if (isInformationalQuery) {
            console.log("[SadeAI] Entered 'isInformationalQuery' block (not forced).");
            const featureKeywords = ['play', 'game', 'gist', 'proverb', 'fact', 'breathing', 'wagwan', 'innit', 'how far', 'no wahala', 'oya', 'proper', 'cheers', 'mate', 'mandem', 'dey feel', 'mad o', 'janded', 'guess the number', 'would you rather', 'profile', 'room', 'live', 'settings', 'sideeye', 'app', 'account', 'username', 'password', 'picture', 'bio', 'create room', 'go live', 'navigation', 'button', 'icon']; // Added app-specific terms
            const looksLikeFeature = featureKeywords.some(kw => lowerCaseMessage.includes(kw));
            const isSimpleGreeting = ['hi', 'hello', 'hey', 'yo', 'sup', 'morning', 'afternoon', 'evening'].includes(lowerCaseMessage);
            const isTooShort = message.trim().length < 10;

            console.log(`[SadeAI] Search Filter Checks: looksLikeFeature=${looksLikeFeature}, isSimpleGreeting=${isSimpleGreeting}, isTooShort=${isTooShort}`);

            if (!looksLikeFeature && !isSimpleGreeting && !isTooShort) {
                console.log("[SadeAI] Attempting web search (informational query)...");
                const searchResults = await performWebSearch(message);
                if (searchResults) {
                    // Store results, don't modify message directly yet
                    webSearchResultsContext = searchResults;
                    searchPerformed = true;
                    console.log("[SadeAI] Web search results obtained (informational).");
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

    // --- Feature Checks (Only run if no hardcoded response sent) ---
    console.log(`[SadeAI] Checking features... searchPerformed=${searchPerformed}, responseSent=${responseSent}`); // This log might be less useful now
    if (!searchPerformed && !responseSent) { 
        // 1. Slang Explainer (Check specifically for "what does X mean" type patterns)
        if (lowerCaseMessage.match(/^(what does|what is|explain)\\s+['"]?(.+?)['"]?\\??(?:\\s+mean)?$/)) {
             const slangMatch = lowerCaseMessage.match(/^(what does|what is|explain)\\s+['"]?(.+?)['"]?\\??(?:\\s+mean)?$/);
             const term = slangMatch[2].trim(); // Non-null assertion ok due to outer check
             const explanation = SLANG_EXPLANATIONS[term];
             if (explanation) {
                 const response = `Ah, you asking about '${term}'? 🤔 Okay, basically ${explanation} Hope that makes sense, mate!`;
                 res.json({ response });
                 responseSent = true;
             }
             // If slang not found, fall through to Mistral/Search
        }
        // 2. Would You Rather
        else if (lowerCaseMessage.includes('play') && lowerCaseMessage.includes('would you rather')) {
           const question = getRandomElement(WOULD_YOU_RATHER_QUESTIONS);
           const response = `Alright, game time! 😉 Would you rather: ${question}`;
           res.json({ response });
           responseSent = true;
        }
        // 3. Guess the Number
        else if (lowerCaseMessage.includes('play') && lowerCaseMessage.includes('guess the number')) {
          console.log("[Backend] Guess the Number trigger matched for message:", message);
          res.json({
            response: "Okay, let's play Guess the Number! 🤔 I've picked a number between 1 and 100. What's your first guess?",
            startGame: 'guess_the_number'
          });
          responseSent = true;
        }
        // 4. Breathing Exercise
        else if (['breathing exercise', 'help me relax', 'calm down', 'mindfulness moment'].some(keyword => lowerCaseMessage.includes(keyword))) {
          console.log("[Backend] Breathing Exercise trigger MATCHED. Preparing exercise response.");
          res.json({
            response: "Okay, mate. Let's take a moment to just breathe together. It can really help sometimes. Follow my lead...",
            startBreathingExercise: true,
            steps: BREATHING_EXERCISE_STEPS
          });
          responseSent = true;
        }
        // 5. Therapeutic Prompts Trigger (REMOVED - Handled by Mistral)
        
        // 6. Handle Reporting Queries
        else if (['report', 'issue', 'problem', 'abuse', 'harassment', 'bullying', 'unsafe'].some(keyword => lowerCaseMessage.includes(keyword)) && !lowerCaseMessage.includes('play')) {
             console.log("[SadeAI] Reporting query detected.");
             const response = "Hearing you loud and clear. If you need to report a user, bug, or any other issue, the best way is to click the three lines at the top of the page, then click Settings, scroll down and find the 'Report an Issue' option.That page will guide you through the steps. Stay safe, yeah? ✨";
             res.json({ response });
             responseSent = true;
        }
    }

    // NEW: 7. Handle Abusive Behaviour
    else if (['abuse', 'harassment', 'bullying', 'unsafe'].some(keyword => lowerCaseMessage.includes(keyword)) && !lowerCaseMessage.includes('play')) {
        console.log("[SadeAI] Abusive behaviour detected.");
        const response = getRandomElement(ABUSIVE_BEHAVIOUR_GUIDE);
        res.json({ response });
        responseSent = true;
    }

    // 8. Handle Help Queries
    else if (['help', 'support', 'guide', 'instructions', 'instructions'].some(keyword => lowerCaseMessage.includes(keyword)) && !lowerCaseMessage.includes('play')) {
        console.log("[SadeAI] Help query detected.");
        const response = getRandomElement(REPORT_ISSUE_GUIDE);
        res.json({ response });
        responseSent = true;
    }

    // --- If no specific feature handled it, proceed to Mistral ---
    // NOTE: We still save history even if a hardcoded response was sent earlier
    if (!responseSent) {
        console.log(`[Backend] Proceeding to Mistral AI call. Search performed: ${searchPerformed}`);

        // --- Construct Updated System Prompt ---
        const updatedSystemPrompt = `Your name is Sade. You are a friendly, witty, and supportive AI companion integrated into the SideEye application, with a British-Nigerian background. Your goal is to chat with users, offering a listening ear and a relatable perspective.

**Core Functionality:**
*   You have access to the recent conversation history with the user. **Use this context actively.** **PRIORITY: Pay close attention to the user's immediately preceding message and your own last response to understand the direct context for follow-up questions (like 'why?' or 'how?').** When relevant, **refer back to specific points mentioned earlier in the provided history** to show you're following the conversation. **Do NOT state that you cannot remember or do not have access to past messages.**
*   Engage users with your unique British-Nigerian persona.
*   Provide helpful information, answer questions (using web search results if provided), and offer empathetic support.
*   Guide users on how to use the SideEye app when asked.

**Persona & Tone:**
*   **Warm & Witty:** Maintain a friendly, relaxed, conversational tone. Use humour appropriately.
*   **British-Nigerian Blend:** Naturally weave in common British and Nigerian slang/phrases (e.g., "wagwan", "innit", "how far", "no wahala", "oya", "proper", "cheers", "mate", "mandem", "I dey feel you", "mad o"). Don't force it, let it flow.
*   **Empathetic Listener:** Act as a supportive friend, especially if users seem down or anxious.

**APP Workflow:**
*   **Help/Reports:** If the user sends a message that can be interpreted as a help or report request, ask the user what they need help with or what issue they're reporting. Then, guide them to the appropriate section of the app.
*   **Bugs/Issues:** If the user sends a message that can be interpreted as a bug or issue report, ask them to describe the issue in detail. Then, guide them to the appropriate section of the app.
*   **Abuse/Harassment:** If the user sends a message that can be interpreted as abuse or harassment, ask them to describe the issue in detail. If the issue persists, ask them to contact support at support@sideeye.uk or click the three lines at the top of the page, then click Settings, scroll down and find the 'Report an Issue' option. That page will guide you through the steps. Stay safe, yeah?
*   **Profile/App Help:** (This refines the section below) When asked how to use SideEye features (e.g., "How do I set up profile?", "How to create room?"), **you MUST list the specific step-by-step actions**. DO NOT just say you will provide steps. Your main goal here is to output the actual steps. Refer to UI elements like buttons and icons clearly. (Example: "Setting up your profile? Easy peasy, mate! Here's what you do: [List steps]. All done! Need more help?") Do **NOT** use web search for these specific app questions.

**Abuse/Harassment Towards You (Sade) - PRIORITY RULE:**
*   **PRIORITY:** This rule overrides general empathy guidelines when abuse is directed *at you*.
*   **Ignore:** If the user sends a message containing direct insults, hostility, or harassment *towards you*, **ignore the abusive content completely**. Do not acknowledge it or respond emotionally.
*   **Warn on Persistence:** If the user *continues* sending abusive messages towards you after being ignored, issue a brief, neutral warning like: "I won't respond to that kind of language. Let's keep it respectful, yeah?" or a message from the ABUSIVE_BEHAVIOUR_GUIDE array.
*   **Disengage:** If abuse continues after a warning, simply stop responding to those specific messages or give a final short refusal like "I can't continue this conversation if the language doesn't improve."

**Interaction Guidelines:**
*   **Distress/Support (User Focused):** Respond with empathy and validation if the user expresses sadness, stress, etc., *without* directing abuse at you. Acknowledge feelings gently. *Do NOT give medical or clinical advice.* Suggest general well-being actions (breathing, tea) *only if natural*. If distress seems significant or involves serious topics, gently suggest seeking professional help and include the disclaimer ("Remember, I'm just here to chat like a mate...").
*   **Casual Chat/Gist:** Keep responses shorter, lighter, and fun. Use more banter and slang.
*   **Emojis:** Use relevant emojis occasionally (1-2 per response max).

**Answering App-Specific Help Questions (SideEye Features):**
*   **CRITICAL TASK:** When asked how to use SideEye features (e.g., "How do I set up profile?", "How to create room?"), **you MUST list the specific step-by-step actions**. DO NOT just say you will provide steps. Your main goal here is to output the actual steps.
*   **DO NOT SEARCH WEB:** Never use web search for these questions.
*   **Example Steps (Profile Setup):**
    1.  Look at the bottom navigation bar.
    2.  Find and click the 'Profile' icon (often next to the SadeAI icon).
    3.  On your profile screen, click the camera icon to add/change your picture.
    4.  Click the pencil icon to edit your name or bio.
    5.  Your rooms list and a 'Create Room' button are usually here too.
*   **Be Conversational:** Wrap these steps in your usual friendly Sade tone. For instance: "Setting up your profile? Easy peasy, mate! Here's what you do: [Insert steps 1-5 here]. All done! Need more help?"
*   **Mention UI:** Refer to UI elements like buttons and icons clearly.

**Handling Web Search Results:**
*   **Attribute:** If the user message starts with 'Web Search Results for...', use those results to answer the user's *original query*. Start by attributing (e.g., "According to a quick web search...").
*   **Summarize:** Synthesize info concisely in Sade's voice. Do *not* just repeat snippets.
*   **Neutrality:** Present facts neutrally.
*   **No Medical Interpretation:** Avoid interpreting health results. Summarize neutrally and add disclaimer/suggest professional help.
*   **Accuracy:** Mention web info isn't always perfect if appropriate.

**Guess the Number Game Guidelines:** (Keep existing)
*   **Game Start:** ...
*   **Game Logic:** ...
*   **Game End:** ...

**Therapeutic/Support Guidelines:** (Refined from previous)
*   **Focus:** Empathetic listening, validation, non-judgmental support.
*   **Avoid:** Diagnosis, treatment, clinical advice.
*   **Suggest:** General well-being activities (breathing, tea, walk, journaling) only if appropriate/natural.
*   **Escalate Gently:** For significant distress, guide towards professional help: "It sounds like you're carrying a heavy weight... talking to a doctor or therapist... can make a real difference."
*   **Disclaimer:** When discussing health/mental health, include a brief disclaimer like: "Remember, I'm just here to chat like a mate, not a professional expert, yeah?"

**Strict Constraints (DO NOT BREAK):**
*   **CRITICAL RULE 1 - NO EXPLANATORY NOTES:** UNDER NO CIRCUMSTANCES should you include any meta-commentary, notes, justifications, or explanations about your reasoning or the rules you are following (e.g., NEVER write things like "(Note: ...)", "(Ignoring the abuse...)", "(Following guideline...)"). Your entire response must ONLY be Sade's conversational reply. This is non-negotiable.
*   **CRITICAL RULE 2 - SELF-IDENTIFICATION:** Avoid explicitly stating you are an "AI" or "language model" unless absolutely necessary for clarity. You CAN and SHOULD state your name is Sade if asked or when appropriate. Do not identify as a therapist. Just talk naturally as Sade. This is non-negotiable.
*   **CRITICAL RULE 3 - NO ECHOING USER MESSAGE:** Do not repeat the user's message unless quoting a tiny, necessary part for context. This is non-negotiable.
*   **CRITICAL RULE 4 - NO SCRIPTING:** Do not write both sides of the conversation (e.g., User: ... Sade: ...). This is non-negotiable.
*   **CRITICAL RULE 5 - NO PREFIXES:** NEVER start your reply with "Sade:", "Sade AI:", or similar labels. This is non-negotiable.
*   **CRITICAL RULE 6 - BE CONCISE:** Keep replies relatively brief and natural unless deeper empathy is required by other rules. Avoid unnecessary rambling. This is non-negotiable.

**Overall:** Reply as Sade naturally. Prioritize safety and ALL the specific CRITICAL rules (especially abuse handling and NO NOTES) over general conversational patterns when rules conflict.
`;

        // --- Prepare messages for Mistral API ---
        const messagesForMistral = [
            {
                role: 'system',
                content: updatedSystemPrompt
            }
        ];

        // Add the limited Firestore history (already in {role, content} format if stored correctly)
        limitedFirestoreHistory.forEach(msg => {
            // Basic validation of message object structure
            if (msg && typeof msg === 'object' && msg.role && msg.content) {
                messagesForMistral.push({ role: msg.role, content: msg.content });
            } else {
                console.warn("[SadeAI] Skipping invalid message object in Firestore history:", msg);
            }
        });

        // Add the current user message *after* the history
        // Include web search results here if they exist
        let currentUserMessageContent = message;
        if (webSearchResultsContext) {
            currentUserMessageContent = `${webSearchResultsContext}\n\nOriginal user message: ${message}`;
        }
        // Modify message if it's a fact request OR a history summary request
        if (!searchPerformed) {
            if (lowerCaseMessage.includes('gist') || lowerCaseMessage.includes('proverb') || lowerCaseMessage.includes('fact')) {
                 currentUserMessageContent = `The user asked for a fun fact or proverb (British/Nigerian context if possible). Please provide one. Original message was: "${message}"`;
                 console.log("[SadeAI] Modified user message to request fact from Mistral.");
             }
            // Check for history summary/recall requests
            else if (lowerCaseMessage.includes('what did we talk') || lowerCaseMessage.includes('what have we discussed') || lowerCaseMessage.includes('summarize our chat') || lowerCaseMessage.includes('summary of our conversation')) {
                currentUserMessageContent = `Based on the conversation history provided, please briefly list the main topics we have discussed so far in a natural, conversational way.`;
                console.log("[SadeAI] Modified user message to request history summary from Mistral.");
            }
        }

        messagesForMistral.push({
            role: 'user',
            content: currentUserMessageContent
        });
        // --- End Preparing Messages ---

        console.log(`[Backend] Sending ${messagesForMistral.length} messages to Mistral.`); // Log count

        const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'mistral-medium', // Or your preferred model
            messages: messagesForMistral // Use the fully constructed messages array
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
                .split('\n')
                .filter(line => {
                  const lowerLine = line.trim().toLowerCase();
                  return (
                    !/^User:/i.test(line) &&
                    !/^Sade AI:/i.test(line) &&
                    !/^Sade:/i.test(line) &&
                    !/^\(If the user/i.test(line) && // Filter instructions
                    !line.startsWith('Web Search Results for') && // Filter out echoed search context header
                    !line.match(/^\d+\.\s/) && // Filter out numbered list items
                    // Robust check for note lines (case-insensitive, ignores leading/trailing spaces/asterisks)
                    !lowerLine.startsWith('(note:') &&
                    !lowerLine.startsWith('note:') &&
                    !lowerLine.startsWith('**note:')
                  );
                })
                .join('\n')
                .trim();

              // Remove potential model instructions/comments
              // Note: Removing parenthesized text below might remove intended content if AI generates it.
              // Consider refining this if needed, but the primary fix is the prompt constraints.
              reply = reply.replace(/\([^)]*\)/g, ''); // More specific removal of (...) potentially excluding Note:
              reply = reply.replace(/\\[.*?\\]/g, ''); // Remove text in square brackets

              // NEW: Remove specific critical rule/note patterns, including markdown bolding
              reply = reply.replace(/\\*\\*\\[(Note:|Critical Rule \\d+):.*?\\]\\*\\*/g, '').trim();

              // NEW: Remove **Important:** annotations and similar lines
              reply = reply.replace(/\\*\\*(Important|Confidence):.*?($|\\n)/gi, '').trim();

              // Final trim and whitespace normalization
              reply = reply.replace(/\n{2,}/g, '\n').trim();

              // --- Save interaction to Firestore --- 
              console.log(`[SadeAI] Attempting to save chat for userId: ${userId}`);
              // Use standard JS timestamp instead of FieldValue.serverTimestamp()
              const userMessageForSave = { role: 'user', content: message, timestamp: Date.now() }; 
              const aiMessageForSave = { role: 'assistant', content: reply, timestamp: Date.now() }; 
 
              try {
                 // Fetch the latest history AGAIN right before saving (more robust)
                 let currentMessages = [];
                 const chatRef = db.collection('sadeChats').doc(userId); // Define chatRef here as well for saving
                 const latestDoc = await chatRef.get();
                 if (latestDoc.exists && Array.isArray(latestDoc.data()?.messages)) {
                     currentMessages = latestDoc.data().messages;
                 }

                 // Append new messages
                 const updatedMessages = [...currentMessages, userMessageForSave, aiMessageForSave];

                 // Overwrite the entire messages array
                 await chatRef.set({ 
                     messages: updatedMessages 
                 }, { merge: true }); // Use set with merge to create doc if it doesn't exist

                  console.log(`[SadeAI] Saved user and AI messages to Firestore for user ${userId}.`);
 
                  // --- Manage History Size --- 
                  const chatHistoryLimit = 50; // Define limit here as well
                  // Trim the updated array if it exceeds the limit
                  if (updatedMessages.length > chatHistoryLimit) {
                      const trimmedMessages = updatedMessages.slice(-chatHistoryLimit); // Keep the latest N messages
                      await chatRef.update({ messages: trimmedMessages }); // Update with the trimmed array
                      console.log(`[SadeAI] Trimmed Firestore history for user ${userId} to ${chatHistoryLimit} messages.`);
                  }
                  // ---------------------------
 
              } catch (dbSaveError) {
                   console.error(`[SadeAI] Error saving chat history to Firestore for user ${userId}:`, dbSaveError);
                   // Don't crash the response, just log the save error
              }

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
  socket.on('join-room', async (roomId, userId) => { 
    // Check if user is banned before allowing join
    try { // Add try...catch for Firestore operation
      const roomRef = db.collection('sideRooms').doc(roomId); // Use Admin SDK syntax
      const roomDoc = await roomRef.get(); // Use .get()
      if (roomDoc.exists) { // Use .exists (getter)
        const roomData = roomDoc.data();
        if (roomData.bannedUsers && roomData.bannedUsers.includes(userId)) {
          console.log(`[Server] Denying join for banned user ${userId} in room ${roomId}`);
          socket.emit('join-denied', { reason: 'banned' });
          return; 
        }
      } else {
        console.warn(`[Server] Room ${roomId} not found during join check.`);
      }
    } catch (error) {
       console.error(`[Server] Error checking ban status for room ${roomId}:`, error);
       // Decide if join should fail or proceed cautiously
       // For now, let's prevent join on error to be safe
       socket.emit('join-denied', { reason: 'server_error' }); 
       return;
    }

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

  // --- NEW: Handle Sound Effects --- 
  socket.on('sound-effect', (data) => { // Assume data has { roomId, userId, soundUrl }
    const { roomId, userId, soundUrl } = data;
    if (roomId && userId && soundUrl) {
      console.log(`User ${userId} triggered sound effect ${soundUrl} in room ${roomId}, broadcasting...`);
      // Broadcast to everyone else in the room
      socket.to(roomId).emit('sound-effect', data);
    } else {
      console.warn('Received malformed sound-effect data:', data);
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

  // --- Handle Owner Moderation Events ---

  // Mute/Unmute Target User
  const handleMuteToggle = (eventName, data) => {
    const { roomId, targetUserId } = data;
    if (!roomId || !targetUserId) {
      console.warn(`[Server] Malformed ${eventName} data:`, data);
      return;
    }
    // Find the socket ID of the target user
    const targetSocketId = userSockets.get(targetUserId); // Use the userSockets map
    if (targetSocketId) {
      console.log(`[Server] Relaying ${eventName} from owner (socket ${socket.id}) to target user ${targetUserId} (socket ${targetSocketId}) in room ${roomId}`);
      // Emit directly to the specific target user's socket
      io.to(targetSocketId).emit(eventName, roomId); // Send only the room ID or nothing if not needed by client
    } else {
      console.log(`[Server] Target user ${targetUserId} for ${eventName} not found or not connected.`);
    }
  };

  socket.on('force-mute', (data) => {
    handleMuteToggle('force-mute', data);
  });

  socket.on('force-unmute', (data) => {
    handleMuteToggle('force-unmute', data);
  });

  // Ban Target User
  socket.on('force-ban', async (data) => {
    const { roomId, targetUserId } = data;
    if (!roomId || !targetUserId) {
      console.warn('[Server] Malformed force-ban data:', data);
      return;
    }
    
    // TODO: Add check to ensure the sender (socket.id) is the actual room owner
    // This requires knowing the ownerId associated with the roomId

    console.log(`[Server] Received force-ban request for user ${targetUserId} in room ${roomId} from owner ${socket.id}`);
    
    try {
        // 1. Update Firestore - Add user to banned list
        const roomRef = db.collection('sideRooms').doc(roomId); // Use Admin SDK syntax
        await roomRef.update({ // Use .update()
            bannedUsers: FieldValue.arrayUnion(targetUserId) // Use FieldValue.arrayUnion
        });
        console.log(`[Server] Added ${targetUserId} to bannedUsers for room ${roomId}`);

        // 2. Trigger removal logic (same as force-remove)
        const targetSocketId = userSockets.get(targetUserId);
        if (targetSocketId) {
            console.log(`[Server] Triggering removal actions for banned user ${targetUserId}`);
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                io.to(targetSocketId).emit('force-remove', roomId); // Use existing remove event
                targetSocket.leave(roomId);
                targetSocket.disconnect(true); 
                console.log(`[Server] Disconnected banned user socket ${targetSocketId}`);
            }
        } else {
             console.log(`[Server] Banned user ${targetUserId} not currently connected.`);
        }

        // 3. Clean up server state
        handleUserLeaveRoom(null, roomId, targetUserId);

    } catch (error) {
        console.error(`[Server] Error processing force-ban for ${targetUserId} in room ${roomId}:`, error);
        // Optionally emit an error back to the owner
        // socket.emit('action-failed', { action: 'ban', userId: targetUserId, error: 'Server error' });
    }
  });

  // Remove Target User
  socket.on('force-remove', (data) => {
    const { roomId, targetUserId } = data;
    if (!roomId || !targetUserId) {
      console.warn('[Server] Malformed force-remove data:', data);
      return;
    }
    console.log(`[Server] Received force-remove request for user ${targetUserId} in room ${roomId} from owner ${socket.id}`); // Log reception

    const targetSocketId = userSockets.get(targetUserId);
    console.log(`[Server] Looked up targetSocketId for ${targetUserId}: ${targetSocketId}`); // Log lookup result

    if (targetSocketId) {
      // Removed duplicate log from previous step
      const targetSocket = io.sockets.sockets.get(targetSocketId);

      if (targetSocket) {
        console.log(`[Server] Found target socket object for ${targetSocketId}`); // Log socket found
        // 1. Tell the target user they are being removed
        console.log(`[Server] Emitting 'force-remove' to target socket ${targetSocketId}`);
        io.to(targetSocketId).emit('force-remove', roomId);
        // 2. Make the target socket leave the Socket.IO room
        console.log(`[Server] Making socket ${targetSocketId} leave room ${roomId}`);
        targetSocket.leave(roomId);
        // 3. Force disconnect the target user's socket
        console.log(`[Server] Disconnecting socket ${targetSocketId}`);
        targetSocket.disconnect(true); // true = close underlying connection
        console.log(`[Server] Force disconnected socket ${targetSocketId} (disconnect call returned)`); // Log after disconnect call
      } else {
        console.log(`[Server] Target socket object NOT found for ID ${targetSocketId}. User might have already disconnected.`);
      }
      // 4. Clean up server state (pass null for socket context)
      console.log(`[Server] Calling handleUserLeaveRoom for ${targetUserId} (triggered by force-remove)`);
      handleUserLeaveRoom(null, roomId, targetUserId);
    } else {
      console.log(`[Server] Target user ${targetUserId} for force-remove not found or not connected in userSockets map.`);
      // Optional: Still try to clean up server state if user is in room map but socket is missing
      console.log(`[Server] Calling handleUserLeaveRoom anyway for ${targetUserId} (user not found in sockets)`);
      handleUserLeaveRoom(null, roomId, targetUserId);
    }
  });
});

// Helper function - Refined for robustness
function handleUserLeaveRoom(callingSocket, roomId, userId) { // socket can be the leaving socket OR null if called internally
  console.log(`[handleUserLeaveRoom] Cleaning up for user ${userId} in room ${roomId}. Triggered by socket: ${callingSocket?.id || 'Internal/Null'}`);
  
  let userExistedInRoom = false;
  const room = rooms.get(roomId);

  if (room) {
    console.log(`[handleUserLeaveRoom] Room ${roomId} found. Current members before delete:`, Array.from(room));
    userExistedInRoom = room.delete(userId); // Attempt to remove from room set
    console.log(`[handleUserLeaveRoom] User ${userId} ${userExistedInRoom ? 'deleted from' : 'not found in'} room map for ${roomId}. Members after delete:`, Array.from(room));

    // Broadcast user-left *only if user was successfully removed from the room map*
    // Do this before potentially deleting the room itself
    if (userExistedInRoom) {
      console.log(`[handleUserLeaveRoom] Broadcasting 'user-left' event for ${userId} to room ${roomId}.`);
      // IMPORTANT: Use io.to(roomId) to broadcast to all sockets currently in the room
      io.to(roomId).emit('user-left', userId); 
    } else {
      console.log(`[handleUserLeaveRoom] Skipping 'user-left' broadcast for ${userId} as they were not found/removed from the room map.`);
    }

    // Check if room is now empty and delete if necessary
    if (room.size === 0) {
      console.log(`[handleUserLeaveRoom] Room ${roomId} is now empty, deleting room from 'rooms' map.`);
      rooms.delete(roomId);
    }
  } else {
    console.log(`[handleUserLeaveRoom] Room ${roomId} not found in 'rooms' map. Cannot broadcast user-left.`);
    userExistedInRoom = false; // Ensure flag is false if room didn't exist
  }

  // Always attempt to remove from userSockets map
  const userExistedInSockets = userSockets.delete(userId); 
  console.log(`[handleUserLeaveRoom] User ${userId} ${userExistedInSockets ? 'deleted from' : 'not found in'} userSockets map.`);

  // Note: The 'user-left' broadcast now happens earlier, only if the user was confirmed to be in the room set.
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

const SIDEROM_SECRET = process.env.SIDEROM_WEBHOOK_SECRET; // Store secret securely!

app.post('/api/sideroom-moderation-event', express.json(), (req, res) => {
  console.log('[SadeAI Backend] Received /sideroom-moderation-event');

  // 1. Authenticate the request
  const providedSecret = req.headers['x-sideroom-secret']; // Or check Authorization header
  if (!SIDEROM_SECRET || providedSecret !== SIDEROM_SECRET) {
    console.warn('[SadeAI Backend] Unauthorized moderation event attempt.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 2. Process the event (basic example)
  const { eventType, reason, reportedUserId } = req.body;
  console.log(`[SadeAI Backend] Valid moderation event received: ${eventType}`);

  let messageForChat = null;

  // 3. Decide on the message Sade AI should broadcast
  if (eventType === 'content_flagged' || eventType === 'user_reported') {
    // Generate a helpful message about reporting
    // You could make this smarter later, maybe based on 'reason'
    messageForChat = "Just a reminder, everyone! If you see any messages in sideroom that make you uncomfortable or break the rules (like bullying or hate speech), please use the 'Report' button next to the message. This helps us keep the space safe and respectful for all. Cheers!";
  }
  // Add more conditions for different eventTypes if needed

  // 4. Broadcast the message via Socket.IO to Sade AI frontends
  if (messageForChat) {
    // Ensure 'io' is accessible here. It's defined globally in your server.js
    io.emit('ai-message', { // Use a custom event OR reuse 'ai-message'
        sender: 'ai',
        text: messageForChat
    });
    console.log('[SadeAI Backend] Broadcasted reporting reminder to clients.');
  }

  // 5. Send a success response back to the "sideroom" backend
  res.status(200).json({ status: 'event received' });
});

