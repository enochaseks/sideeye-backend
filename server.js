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

// Load .env file FIRST - ONLY if not in production
if (process.env.NODE_ENV !== 'production') {
  const dotenvResult = require('dotenv').config();
  if (dotenvResult.error) {
    console.warn('Warning: Error loading .env file:', dotenvResult.error.message); // Use warn, not error
  } else {
    console.log('.env file loaded successfully.');
  }
}

// Initialize Stripe AFTER environment variables are loaded
let stripe;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('Stripe initialized successfully');
  } else {
    console.warn('Stripe Secret Key not found - payment features will be disabled');
    stripe = null; // Explicitly set to null
  }
} catch (error) {
  console.error('Error initializing Stripe:', error);
  stripe = null; // Ensure stripe is null on error
}
// For more direct debugging, uncomment these lines temporarily:
// console.log('RAW STREAM_API_KEY from process.env after dotenv:', process.env.STREAM_API_KEY);
// console.log('RAW STREAM_API_SECRET from process.env after dotenv:', process.env.STREAM_API_SECRET);

// --- Stream Chat SDK --- 
const { StreamChat } = require('stream-chat');
let streamClient;
// --- End Stream Chat SDK ---

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ['https://www.sideeye.uk', 'https://sideeye.uk', 'http://localhost:3000'],
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
  'https://www.sideeye.uk', // With www
  'https://sideeye.uk',    // WITHOUT www - ADD THIS
  'http://localhost:3000'
  // Add any other origins you need to support, like specific preview deployment URLs
];

// Use simpler CORS config again
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      // Log the problematic origin before rejecting
      console.warn(`[CORS] Rejected Origin: "${origin}". Not in allowed list:`, allowedOrigins);
      // const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      // return callback(new Error(msg), false); // DON'T throw error, just disallow
      return callback(null, false); // Signal to disallow this origin
    }
    // Origin is allowed
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'], // Explicitly list all methods you use
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token', 'Accept', 'Origin'], // Add more common headers
  exposedHeaders: ['Content-Length', 'X-Request-ID'], // If you use any custom headers client needs to read
  optionsSuccessStatus: 200 // Changed from 204 to 200 for broader compatibility
};

// Explicit OPTIONS handler using the SAME refined options
// IMPORTANT: Place this BEFORE the general app.use(cors(corsOptions))
// app.options('*', cors(corsOptions)); // REMOVE THIS LINE - Let app.use(cors()) handle preflights

// Apply the main CORS middleware
app.use(cors(corsOptions));

// Explicitly handle OPTIONS requests for the specific API route *before* other middleware
// This ensures preflight requests get the right headers immediately.
// app.options('/api/sade-ai', cors(corsOptions)); // REMOVED - General CORS should handle this

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
  console.log('[Firebase Init] Starting Firebase Admin SDK initialization...');
  console.log('[Firebase Init] Environment:', process.env.NODE_ENV);
  
  if (process.env.NODE_ENV === 'production') {
    console.log('[Firebase Init] Production mode - checking SERVICE_ACCOUNT_KEY...');
    if (!process.env.SERVICE_ACCOUNT_KEY) {
      throw new Error('SERVICE_ACCOUNT_KEY environment variable is not set in production');
    }
    try {
      serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
      console.log('[Firebase Init] SERVICE_ACCOUNT_KEY parsed successfully');
    } catch (parseError) {
      throw new Error('Invalid SERVICE_ACCOUNT_KEY format: ' + parseError.message);
    }
  } else {
    console.log('[Firebase Init] Development mode - loading serviceAccountKey.json...');
    try {
      serviceAccount = require('./serviceAccountKey.json');
      console.log('[Firebase Init] serviceAccountKey.json loaded successfully');
    } catch (fileError) {
      throw new Error('serviceAccountKey.json file not found or invalid: ' + fileError.message);
    }
  }

  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('Invalid service account configuration - missing required fields');
  }

  console.log('[Firebase Init] Service account validated, initializing Firebase Admin...');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'sideeye-bafda.appspot.com'
  });
  console.log('Firebase Admin SDK initialized successfully');
  // Get Firestore database instance and assign it
  db = admin.firestore(); 
  console.log('[Firebase Init] Firestore database instance created');
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
  console.error('Error details:', error.message);
  console.error('Stack trace:', error.stack);
  
  // In production, we should exit, but let's add more debugging
  if (process.env.NODE_ENV === 'production') {
    console.error('[Firebase Init] CRITICAL: Firebase initialization failed in production');
    console.error('[Firebase Init] Available environment variables:');
    console.error('  - NODE_ENV:', process.env.NODE_ENV);
    console.error('  - SERVICE_ACCOUNT_KEY:', process.env.SERVICE_ACCOUNT_KEY ? 'SET (length: ' + process.env.SERVICE_ACCOUNT_KEY.length + ')' : 'NOT SET');
    console.error('  - FIREBASE_STORAGE_BUCKET:', process.env.FIREBASE_STORAGE_BUCKET || 'NOT SET');
    
    // Don't exit immediately in production - let Railway restart the service
    console.error('[Firebase Init] Waiting 10 seconds before exit to allow Railway to capture logs...');
    setTimeout(() => {
      console.error('[Firebase Init] Exiting due to Firebase initialization failure');
      process.exit(1);
    }, 10000); // Wait 10 seconds
    return; // Don't continue with server startup
  }
  
  process.exit(1);
}

// --- Initialize Stream Client ---
// IMPORTANT: Ensure these are set in your .env file and Railway environment variables
const STREAM_API_KEY = process.env.STREAM_API_KEY;
const STREAM_API_SECRET = process.env.STREAM_API_SECRET;
const STREAM_APP_ID = process.env.STREAM_APP_ID;

try {
  if (STREAM_API_KEY && STREAM_API_SECRET) {
    streamClient = StreamChat.getInstance(STREAM_API_KEY, STREAM_API_SECRET);
    console.log('Stream Chat SDK initialized successfully.');
  } else {
    console.warn('Stream API Key or Secret is missing in environment variables! Stream features will be impacted.');
    streamClient = null; // Explicitly set to null
  }
} catch (error) {
  console.error('Error initializing Stream Chat SDK:', error);
  streamClient = null; // Ensure streamClient is null on error
}
// --- End Initialize Stream Client ---

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

// --- Stream Token Endpoint ---
app.post('/api/stream-token', async (req, res) => {
  console.log('--- /api/stream-token HIT ---');
  // Log Headers (especially Origin)
  console.log('[Stream Token Route] Request Origin Header:', req.headers.origin); // Direct access
  console.log('[Stream Token Route] Full Request Headers:', JSON.stringify(req.headers, null, 2));
  
  if (!streamClient) {
    console.error('[Stream Token Route] Stream client not initialized!');
    return res.status(500).json({ error: 'Stream service not configured on server.' });
  }

  try {
    const { userId, userName, userImage } = req.body; 
    console.log(`[Stream Token Route] Parsed body - userId: ${userId}, userName: ${userName}, userImage: ${userImage}`); // Log parsed body

    if (!userId) {
      console.warn('[Stream Token Route] User ID missing in request body.');
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    // Firebase Auth Verification Step
    try {
      console.log(`[Stream Token Route] Verifying user ${userId} with Firebase Auth...`);
      const userAuthRecord = await admin.auth().getUser(userId);
      console.log(`[Stream Token Route] Verified user ${userId} with Firebase Auth successfully.`);
    } catch (authError) { 
      console.warn(`[Stream Token Route] Failed to verify user ${userId} with Firebase Auth:`, authError.message);
      // Decide if you want to block token generation if Firebase verification fails.
      // For now, we'll proceed but log a warning.
      // return res.status(403).json({ error: 'User verification failed.' });
    }
    
    // Stream Upsert User Step
    console.log(`[Stream Token Route] Upserting user ${userId} in Stream...`);
    await streamClient.upsertUser({
        id: userId,
        name: userName || userId, 
        image: userImage || undefined,
        displayName: userName || userId, 
        customAvatarUrl: userImage || undefined
    });
    console.log(`[Stream Token Route] Upserted user ${userId} in Stream successfully.`);

    // Stream Create Token Step
    console.log(`[Stream Token Route] Creating Stream token for user ${userId}...`);
    const token = streamClient.createToken(userId);
    console.log(`[Stream Token Route] Created Stream token successfully for user ${userId}.`);

    // Sending Response Step
    console.log(`[Stream Token Route] Sending JSON response with token for user ${userId}...`);
    res.json({ token });
    console.log(`[Stream Token Route] JSON response sent successfully for user ${userId}.`); // Log AFTER sending

  } catch (error) { 
    console.error('[Stream Token Route] Error inside handler:', error);
    res.status(500).json({ error: 'Failed to generate Stream token', details: error.message });
  }
});
// --- End Stream Token Endpoint ---

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('[HEALTH CHECK] Responding 200 OK'); // Add log
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    firebase: !!db,
    stripe: !!stripe,
    stream: !!streamClient
  });
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

// Simple test endpoint to verify deployment
app.get('/api/deployment-status', (req, res) => {
  res.json({ 
    message: 'Deployment successful!',
    timestamp: new Date().toISOString(),
    version: '2.1.0',
    hasPaymentEndpoint: true
  });
});

// Test endpoint specifically for payment route
app.get('/api/payment-test', (req, res) => {
  res.json({ 
    message: 'Payment route is accessible!',
    timestamp: new Date().toISOString(),
    paymentEndpointExists: true
  });
});

// GET version of payment endpoint for testing
app.get('/api/process-gift-payment', (req, res) => {
  res.json({ 
    message: 'Payment endpoint is accessible via GET!',
    timestamp: new Date().toISOString(),
    note: 'Use POST method for actual payments'
  });
});

// MOVED: Real gift payment endpoint - processes actual payments with Stripe
app.post('/api/process-gift-payment', async (req, res) => {
    try {
        const {
            giftId,
            giftName,
            amount, // Amount in GBP (e.g., 0.50 for 50p)
            currency = 'GBP',
            senderId,
            senderName,
            receiverId,
            roomId,
            paymentMethod,
            paymentDetails,
            customerEmail,
            description,
            metadata
        } = req.body;

        console.log('[Gift Payment] Processing real gift payment:', {
            giftId,
            giftName,
            amount,
            currency,
            senderId,
            receiverId,
            roomId,
            paymentMethod
        });

        // Validate required fields
        if (!giftId || !giftName || !amount || !senderId || !receiverId || !roomId || !paymentMethod) {
            return res.status(400).json({
                success: false,
                error: 'Missing required payment information'
            });
        }

        // Validate payment amount
        if (amount < 0.50 || amount > 100) {
            return res.status(400).json({
                success: false,
                error: 'Invalid payment amount. Must be between £0.50 and £100.'
            });
        }

        // Validate payment details for card payments
        if (paymentMethod === 'card' && paymentDetails) {
            const { cardNumber, expiryMonth, expiryYear, cvc, cardholderName } = paymentDetails;
            
            if (!cardNumber || !expiryMonth || !expiryYear || !cvc) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required card details'
                });
            }
            
            // Basic card number validation
            const cleanCardNumber = cardNumber.replace(/\s/g, '');
            if (cleanCardNumber.length < 13 || cleanCardNumber.length > 19) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid card number'
                });
            }
        }

        let paymentResult;
        const paymentId = `gift_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Process payment with Stripe
        if (stripe && paymentMethod === 'card') {
            try {
                console.log('[Gift Payment] Processing with Stripe...');
                
                // Create payment method
                const paymentMethodObj = await stripe.paymentMethods.create({
                    type: 'card',
                    card: {
                        number: paymentDetails.cardNumber.replace(/\s/g, ''),
                        exp_month: parseInt(paymentDetails.expiryMonth),
                        exp_year: parseInt(paymentDetails.expiryYear),
                        cvc: paymentDetails.cvc,
                    },
                    billing_details: {
                        name: paymentDetails.cardholderName || 'Anonymous',
                        email: customerEmail
                    }
                });

                // Create and confirm payment intent
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: Math.round(amount * 100), // Convert to pence
                    currency: currency.toLowerCase(),
                    payment_method: paymentMethodObj.id,
                    confirmation_method: 'manual',
                    confirm: true,
                    description: description || `SideEye Gift: ${giftName}`,
                    receipt_email: customerEmail,
                    metadata: {
                        ...metadata,
                        giftId,
                        senderId,
                        receiverId,
                        roomId,
                        type: 'gift_payment',
                        paymentId
                    }
                });

                if (paymentIntent.status === 'succeeded') {
                    paymentResult = {
                        success: true,
                        paymentId: paymentId,
                        transactionId: paymentIntent.id,
                        stripePaymentIntentId: paymentIntent.id
                    };
                    console.log('[Gift Payment] Stripe payment succeeded:', paymentIntent.id);
                } else if (paymentIntent.status === 'requires_action') {
                    return res.status(400).json({
                        success: false,
                        error: 'Payment requires additional authentication. Please try a different card.',
                        requiresAction: true,
                        clientSecret: paymentIntent.client_secret
                    });
                } else {
                    throw new Error(`Payment failed with status: ${paymentIntent.status}`);
                }

            } catch (stripeError) {
                console.error('[Gift Payment] Stripe error:', stripeError);
                
                // Handle specific Stripe errors
                let errorMessage = 'Payment processing failed';
                if (stripeError.type === 'StripeCardError') {
                    errorMessage = stripeError.message || 'Your card was declined';
                } else if (stripeError.type === 'StripeInvalidRequestError') {
                    errorMessage = 'Invalid payment information';
                } else if (stripeError.type === 'StripeAPIError') {
                    errorMessage = 'Payment service temporarily unavailable';
                }
                
                return res.status(400).json({
                    success: false,
                    error: errorMessage
                });
            }
        } else {
            // Fallback for when Stripe is not configured (demo mode)
            console.log('[Gift Payment] Stripe not configured, using demo mode');
            paymentResult = {
                success: true,
                paymentId: paymentId,
                transactionId: paymentId,
                demo: true
            };
        }

        if (!paymentResult.success) {
            return res.status(400).json({
                success: false,
                error: paymentResult.error || 'Payment processing failed'
            });
        }

        // Only process gift if payment was successful
        await processGiftPaymentSuccess({
            giftId,
            giftName,
            senderId,
            senderName,
            receiverId,
            roomId,
            amount,
            currency,
            paymentId: paymentResult.paymentId,
            paymentMethod,
            transactionId: paymentResult.transactionId,
            stripePaymentIntentId: paymentResult.stripePaymentIntentId,
            customerEmail: customerEmail,
            isDemo: paymentResult.demo || false
        });

        res.json({
            success: true,
            message: 'Payment processed and gift sent successfully!',
            paymentId: paymentResult.paymentId,
            transactionId: paymentResult.transactionId,
            demo: paymentResult.demo || false
        });

    } catch (error) {
        console.error('[Gift Payment] Error processing payment:', error);
        res.status(500).json({
            success: false,
            error: 'Payment processing failed. Please try again.'
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

// Data for new features
const GISTS_PROVERBS = [
  "Did you know? Lagos is one of the fastest-growing cities in the world! Mad o!",
  "Proverb time: 'Monkey no fine but im mama like am.' Means everyone is loved by someone, innit?",
  "Gist for you: The River Thames is the longest river entirely in England. Proper long!",
  "Proverb time: 'Na clap hand dem dey take enter dance.' Means you gotta start somewhere, take the first step!",
  "Quick one: There are over 500 languages spoken in Nigeria! Plenty vibes.",
  "Cheeky fact: The Queen has two birthdays. Lucky her, eh?",
];

// Track users who just submitted a report (in-memory map)
// Map<userId, {reportId: string, timestamp: number}>
const activeReportFollowups = new Map();

// Track users in the report creation flow (in-memory map)
// Map<userId, {step: 'type' | 'details', reportType?: string, timestamp: number}>
const activeReportFlows = new Map();

// Report types that match the formal reporting UI
const REPORT_TYPES = [
  { value: 'user', label: 'Report a User (Harassment, Abuse, etc.)' },
  { value: 'bug', label: 'Report a Bug or Technical Issue' },
  { value: 'content', label: 'Report Inappropriate Content' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'hate_speech', label: 'Hate Speech' },
  { value: 'other', label: 'Other Issue' }
];

// Cleanup interval for expired report states (runs every 30 minutes)
setInterval(() => {
  const now = Date.now();
  let expiredFollowupsCount = 0;
  let expiredFlowsCount = 0;
  
  // Clean up report followups
  activeReportFollowups.forEach((data, userId) => {
    if (data.expiresAt < now) {
      activeReportFollowups.delete(userId);
      expiredFollowupsCount++;
    }
  });
  
  // Clean up report creation flows
  activeReportFlows.forEach((data, userId) => {
    if (data.expiresAt < now) {
      activeReportFlows.delete(userId);
      expiredFlowsCount++;
    }
  });
  
  if (expiredFollowupsCount > 0 || expiredFlowsCount > 0) {
    console.log(`[SadeAI] Cleaned up ${expiredFollowupsCount} expired report follow-ups and ${expiredFlowsCount} expired report flows`);
  }
}, 30 * 60 * 1000); // 30 minutes

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
       
       // Create an array to store source links
       const sourceLinks = [];
       
       data.items.forEach((item, index) => {
           // Prioritize snippet, fallback to title, skip if neither exists
           const text = item.snippet || item.title;
           if (text) {
               // Basic cleaning of snippets (remove excessive newlines/whitespace)
               resultsText += `${index + 1}. ${text.replace(/\\s+/g, ' ').trim()}\\n`;
               
               // Store link information 
               if (item.link) {
                   let displayTitle = item.title || 'Untitled Source';
                   if (displayTitle.length > 60) {
                       displayTitle = displayTitle.substring(0, 57) + '...';
                   }
                   
                   sourceLinks.push({
                       title: displayTitle,
                       url: item.link,
                       displayUrl: item.displayLink || new URL(item.link).hostname
                   });
               }
           }
       });
       
       // Only proceed if we actually formatted some text
       if (resultsText.trim().length > `Web Search Results for "${searchQuery}":\\n`.length) {
           return {
               text: resultsText.trim(),
               sourceLinks: sourceLinks
           };
       }
       return null;
    } else {
       console.log("[Backend] Web search returned no results.");
       return null;
    }
  } catch (error) {
    console.error("[Backend] Error during web search fetch:", error);
    return null; // Return null on network or other errors
  }
}

// --- Connect 4 Game Data ---
const CONNECT4_ROWS = 6;
const CONNECT4_COLS = 7;
const PLAYER_USER = '🔴'; // User uses Red
const PLAYER_AI = '🟡';   // Sade uses Yellow
const EMPTY_SLOT = '⚪'; // Empty slot

// In-memory storage for active Connect 4 games
// Map<userId, { board: string[][], turn: 'User' | 'AI', gameOver: boolean, winner: 'User' | 'AI' | 'Draw' | null }>
const connect4Games = new Map();

// Creates a new empty Connect 4 board
function createConnect4Board() {
  const board = [];
  for (let r = 0; r < CONNECT4_ROWS; r++) {
    board[r] = [];
    for (let c = 0; c < CONNECT4_COLS; c++) {
      board[r][c] = EMPTY_SLOT;
    }
  }
  return board;
}

// --- Connect 4 Game Helpers ---

// Checks if a column has space for a move
function isValidMove(board, col) {
  // Check if col is within bounds (0-indexed) and the top row in that column is empty
  return col >= 0 && col < CONNECT4_COLS && board[0][col] === EMPTY_SLOT;
}

// Places a player's piece in the lowest available row of a column
// Returns the row index where the piece was placed, or -1 if column is full
function makeMove(board, col, player) {
  for (let r = CONNECT4_ROWS - 1; r >= 0; r--) {
    if (board[r][col] === EMPTY_SLOT) {
      board[r][col] = player;
      return r; // Return the row where the piece landed
    }
  }
  return -1; // Should not happen if isValidMove was checked first, but good safeguard
}

// Checks if the last move resulted in a win
function checkForWin(board, player) {
    // Check horizontal, vertical, and both diagonals

    // Horizontal check
    for (let r = 0; r < CONNECT4_ROWS; r++) {
        for (let c = 0; c <= CONNECT4_COLS - 4; c++) {
            if (board[r][c] === player && board[r][c+1] === player && board[r][c+2] === player && board[r][c+3] === player) {
                return true;
            }
        }
    }

    // Vertical check
    for (let r = 0; r <= CONNECT4_ROWS - 4; r++) {
        for (let c = 0; c < CONNECT4_COLS; c++) {
            if (board[r][c] === player && board[r+1][c] === player && board[r+2][c] === player && board[r+3][c] === player) {
                return true;
            }
        }
    }

    // Positive diagonal (\) check
    for (let r = 0; r <= CONNECT4_ROWS - 4; r++) {
        for (let c = 0; c <= CONNECT4_COLS - 4; c++) {
            if (board[r][c] === player && board[r+1][c+1] === player && board[r+2][c+2] === player && board[r+3][c+3] === player) {
                return true;
            }
        }
    }

    // Negative diagonal (/) check
    for (let r = 3; r < CONNECT4_ROWS; r++) {
        for (let c = 0; c <= CONNECT4_COLS - 4; c++) {
            if (board[r][c] === player && board[r-1][c+1] === player && board[r-2][c+2] === player && board[r-3][c+3] === player) {
                return true;
            }
        }
    }

    return false;
}

// Checks if the board is full (draw condition)
function checkForDraw(board) {
  // Check if the top row is full
  for (let c = 0; c < CONNECT4_COLS; c++) {
    if (board[0][c] === EMPTY_SLOT) {
      return false; // Found an empty slot, not a draw
    }
  }
  return true; // Top row is full, it's a draw
}

// Simple AI: finds the first valid column to play in
// TODO: Make this smarter later!
function getAIMove(board) {
    const validMoves = [];
    for (let c = 0; c < CONNECT4_COLS; c++) {
        if (isValidMove(board, c)) {
            validMoves.push(c);
        }
    }
    // Pick a random valid move if available
    if (validMoves.length > 0) {
        return validMoves[Math.floor(Math.random() * validMoves.length)];
    }
    return -1; // No valid moves (should only happen in a draw, handled by checkForDraw)
}

// Formats the board into a string for display in chat
function formatBoardToString(board) {
    let boardString = " 1  2  3  4  5  6  7\n"; // Column numbers
    boardString += board.map(row => row.join('')).join('\n');
    return boardString;
}

// --- End Connect 4 Game Helpers ---

// Add language detection function
const detectLanguage = (text) => {
  // Common words and phrases in different languages
  const languagePatterns = {
    yoruba: [
      /\b(bawo|dara|e|o|se|wa|ni|ti|ko|mo|mi|re|wa|won|yin|won|ti|ko|mo|mi|re|wa|won|yin|won)\b/i,
      /\b(eku|eku odun|eku ile|eku aaro|eku ale|eku ojo|eku osan|eku oru)\b/i,
      /\b(pele|pele o|pele e|pele oo|pele eo)\b/i
    ],
    igbo: [
      /\b(kedu|nno|daalu|biko|nna|nne|nwanne|nwoke|nwaanyi|nwa|nwata|nwoke|nwaanyi)\b/i,
      /\b(ka|ka chi|ka o di|ka o di mma|ka o di nma|ka o di nma o|ka o di nma e)\b/i
    ],
    twi: [
      /\b(wo|me|ye|yɛ|ɛ|ɔ|a|e|i|o|u|n|m|ŋ|h|w|y|r|l|k|g|t|d|n|p|b|m|f|v|s|z|ʃ|ʒ|h|w|y|r|l)\b/i,
      /\b(ɛte sɛn|ɛte sɛn na|ɛte sɛn na ɛ|ɛte sɛn na ɛ|ɛte sɛn na ɛ|ɛte sɛn na ɛ)\b/i
    ],
    afemai: [
      /\b(oghene|oghene o|oghene e|oghene oo|oghene eo)\b/i,
      /\b(oghene o|oghene e|oghene oo|oghene eo)\b/i
    ]
  };

  // Check each language's patterns
  for (const [lang, patterns] of Object.entries(languagePatterns)) {
    if (patterns.some(pattern => pattern.test(text))) {
      return lang;
    }
  }

  // Default to English if no other language is detected
  return 'english';
};

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

    // --- Check for Report Follow-Up ---
    const activeReport = activeReportFollowups.get(userId);
    if (activeReport && activeReport.expiresAt > Date.now()) {
      try {
        console.log(`[SadeAI] Processing follow-up for report ${activeReport.reportId} from user ${userId}`);
        console.log(`[SadeAI] Follow-up message content: "${message}"`);
        
        // Check for specific issue types in the follow-up message
        const lowerCaseFollowUp = message.toLowerCase();
        let issueType = null;
        
        if (lowerCaseFollowUp.includes('racial') || lowerCaseFollowUp.includes('race') || lowerCaseFollowUp.includes('racism')) {
          issueType = 'racial_issue';
        } else if (lowerCaseFollowUp.includes('harass') || lowerCaseFollowUp.includes('stalk')) {
          issueType = 'harassment';
        } else if (lowerCaseFollowUp.includes('threat') || lowerCaseFollowUp.includes('danger')) {
          issueType = 'threat';
        } else if (lowerCaseFollowUp.includes('bug') || lowerCaseFollowUp.includes('glitch') || lowerCaseFollowUp.includes('not working')) {
          issueType = 'technical_issue';
        }
        
        // Update the existing report with the follow-up message and issue type if detected
        const reportRef = db.collection('userReports').doc(activeReport.reportId);
        const updateData = {
          followUpMessages: FieldValue.arrayUnion({
            content: message,
            timestamp: FieldValue.serverTimestamp()
          })
        };
        
        // Add the issue type if detected
        if (issueType) {
          updateData.issueType = issueType;
          updateData.priority = (issueType === 'racial_issue' || issueType === 'harassment' || issueType === 'threat') ? 'high' : 'normal';
          console.log(`[SadeAI] Detected issue type: ${issueType}, setting priority: ${updateData.priority}`);
        }
        
        await reportRef.update(updateData);
        
        // Clear the follow-up state after the user has provided additional info
        activeReportFollowups.delete(userId);
        console.log(`[SadeAI] Stored follow-up message and cleared follow-up state for user ${userId}`);
        
        // Respond to the user with appropriate message based on issue type
        let response = "Thank you for sharing that information. I've added these details to your report. Our team takes these matters very seriously and will review this as a priority.";
        
        if (issueType === 'racial_issue' || issueType === 'harassment' || issueType === 'threat') {
          response += " I'm sorry you've experienced this. Everyone deserves to be treated with respect.";
        }
        
        res.json({ response });
        responseSent = true; // Exit early to ensure no other handlers process this message
      } catch (error) {
        console.error(`[SadeAI] Error updating report with follow-up:`, error);
        // Don't set responseSent to true so it can fall through to normal handling
      }
    }
    
    // --- Check for Active Report Flow ---
    const activeFlow = activeReportFlows.get(userId);
    if (activeFlow && activeFlow.expiresAt > Date.now()) {
      console.log(`[SadeAI] Processing report flow step ${activeFlow.step} for user ${userId}`);
      
      if (activeFlow.step === 'type') {
        // User is responding with the report type
        const selectedType = message.toLowerCase();
        let matchedType = null;
        
        // Try to match user input to a report type
        for (const type of REPORT_TYPES) {
          if (selectedType.includes(type.value.toLowerCase()) || 
              selectedType.includes(type.label.toLowerCase())) {
            matchedType = type.value;
            break;
          }
        }
        
        // If we couldn't match to a type, default to 'other'
        if (!matchedType) {
          if (selectedType.includes('1')) matchedType = 'user';
          else if (selectedType.includes('2')) matchedType = 'bug';
          else if (selectedType.includes('3')) matchedType = 'content';
          else if (selectedType.includes('4')) matchedType = 'harassment';
          else if (selectedType.includes('5')) matchedType = 'hate_speech';
          else matchedType = 'other';
        }
        
        // Update the flow state to collect details next
        activeReportFlows.set(userId, {
          step: 'details',
          reportType: matchedType,
          timestamp: Date.now(),
          expiresAt: Date.now() + (10 * 60 * 1000) // 10 minutes
        });
        
        console.log(`[SadeAI] User selected report type: ${matchedType}`);
        
        // Ask for details based on the report type
        let response = '';
        if (matchedType === 'user') {
          response = "Could you please provide the username of the person you're reporting, as well as what happened?";
        } else if (matchedType === 'bug') {
          response = "Could you please describe the technical issue you're experiencing in detail? What were you trying to do when it occurred?";
        } else {
          response = "Could you please describe what happened in as much detail as possible?";
        }
        
        res.json({ response });
        responseSent = true;
        return;
      } 
      else if (activeFlow.step === 'details') {
        // User is providing details, create the actual report
        try {
          console.log(`[SadeAI] Creating report of type ${activeFlow.reportType} with details: "${message}"`);
          
          // Create the report document
          const reportRef = await db.collection('userReports').add({
            userId: userId,
            reportType: activeFlow.reportType,
            reportContent: message,
            timestamp: FieldValue.serverTimestamp(),
            status: 'new'
          });
          
          // Clear the flow state
          activeReportFlows.delete(userId);
          
          // Set follow-up state to collect additional info if needed
          activeReportFollowups.set(userId, {
            reportId: reportRef.id,
            timestamp: Date.now(),
            expiresAt: Date.now() + (10 * 60 * 1000) // 10 minutes
          });
          
          console.log(`[SadeAI] Report created with ID: ${reportRef.id}, now awaiting follow-up`);
          
          // Respond to user
          const response = "Thank you for providing those details. I've created a report that our team will review. Is there anything else you'd like to add about this issue?";
          res.json({ response });
          responseSent = true;
          return;
        } catch (error) {
          console.error(`[SadeAI] Error creating report:`, error);
          // Fall through to regular handling if there's an error
        }
      }
    }
    
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
            webSearchResultsContext = searchResults.text;
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
                    webSearchResultsContext = searchResults.text;
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
        // --- NEW: Connect 4 Game Start ---
        if ((lowerCaseMessage.includes('play') && (lowerCaseMessage.includes('connect 4') || lowerCaseMessage.includes('connect four'))) ||
            (lowerCaseMessage.includes('start') && (lowerCaseMessage.includes('connect 4') || lowerCaseMessage.includes('connect four'))))
        {
             console.log(`[SadeAI] Connect 4 game request detected for user ${userId}.`);
             // Check if a game is already active for this user
             if (connect4Games.has(userId)) {
                 // TODO: Handle resuming an existing game or confirming restart later
                 const existingGame = connect4Games.get(userId);
                 if (!existingGame.gameOver) {
                    console.log(`[SadeAI] Connect 4 game already active for user ${userId}.`);
                    // For now, just remind them a game is in progress.
                    // We'll add board formatting later.
                    res.json({
                        response: "Looks like we're already playing Connect 4, mate! It's your turn. What column (1-7)?"
                        // TODO: Add board state to response later
                    });
                    responseSent = true;
                 } else {
                     // Game was over, start a new one
                     console.log(`[SadeAI] Previous game for ${userId} was over. Starting new Connect 4 game.`);
                     connect4Games.delete(userId); // Clear old game
                 }
             }

             // If no game was active OR the previous one was finished
             if (!responseSent) {
                 const newBoard = createConnect4Board();
                 const newGame = {
                    board: newBoard,
                    turn: 'User', // User goes first
                    gameOver: false,
                    winner: null
                 };
                 connect4Games.set(userId, newGame);
                 console.log(`[SadeAI] Started new Connect 4 game for user ${userId}.`);

                 // Format the board for the response message
                 let boardString = "Alright, Connect 4 it is! You're Red (🔴), I'm Yellow (🟡). You go first.\n\n";
                 boardString += " 1  2  3  4  5  6  7\n"; // Column numbers
                 boardString += newBoard.map(row => row.join('')).join('\n');
                 boardString += "\n\nYour move! Pick a column (1-7).";

                 res.json({
                     response: boardString,
                     startGame: 'connect_4', // Add a flag for the frontend
                     board: newBoard // Send initial board state
                 });
                 responseSent = true;
            }
        }
        // --- END: Connect 4 Game Start ---

        // --- Connect 4 Move Handling ---
        else if (message.startsWith('connect4_move_')) {
            console.log(`[SadeAI] Connect 4 move received from user ${userId}: ${message}`);
            const game = connect4Games.get(userId);

            if (!game) {
                console.log(`[SadeAI] Connect 4 move received, but no active game found for user ${userId}.`);
                res.json({ error: "Hmm, we don't seem to be playing Connect 4 right now. Ask me to play!" });
                responseSent = true;
            } else if (game.gameOver) {
                console.log(`[SadeAI] Connect 4 move received, but the game is already over for user ${userId}.`);
                res.json({ error: "Looks like that game's finished, mate! Ask me to play again if you fancy another round." });
                responseSent = true;
            } else if (game.turn !== 'User') {
                console.log(`[SadeAI] Connect 4 move received, but it's not the user's turn for user ${userId}.`);
                res.json({ error: "Hold your horses! It's my turn right now. 😉" });
                responseSent = true;
            } else {
                // Extract column number (adjust for 0-based index)
                const col = parseInt(message.split('_')[2], 10) - 1;

                if (!isValidMove(game.board, col)) {
                    console.log(`[SadeAI] Invalid move (column ${col + 1}) received for user ${userId}.`);
                    res.json({ error: `Oops! Column ${col + 1} is full or invalid. Try another column (1-7).` });
                    // Don't change turn or update board state
                    responseSent = true;
                } else {
                    // --- User's Move ---
                    makeMove(game.board, col, PLAYER_USER);
                    console.log(`[SadeAI] User ${userId} placed piece in column ${col + 1}.`);

                    // Check for user win
                    if (checkForWin(game.board, PLAYER_USER)) {
                        game.gameOver = true;
                        game.winner = 'User';
                        connect4Games.set(userId, game); // Update game state
                        console.log(`[SadeAI] User ${userId} won the game.`);
                        res.json({
                            gameUpdate: 'connect_4',
                            response: `Yes! You got it! Proper smart move. You win! 🎉\n\n${formatBoardToString(game.board)}\n\nWant to play again?`,
                            board: game.board,
                            turn: game.turn,
                            gameOver: game.gameOver,
                            winner: game.winner
                        });
                        responseSent = true;
                    }
                    // Check for draw (after user move)
                    else if (checkForDraw(game.board)) {
                        game.gameOver = true;
                        game.winner = 'Draw';
                        connect4Games.set(userId, game); // Update game state
                        console.log(`[SadeAI] Game ended in a draw for user ${userId}.`);
                        res.json({
                            gameUpdate: 'connect_4',
                            response: `Phew! Looks like it's a draw! Good game, mate! 🤝\n\n${formatBoardToString(game.board)}\n\nWant to play again?`,
                            board: game.board,
                            turn: game.turn,
                            gameOver: game.gameOver,
                            winner: game.winner
                        });
                        responseSent = true;
                    } else {
                         // --- AI's Turn (if game not over) ---
                         game.turn = 'AI';
                         const aiCol = getAIMove(game.board);
                         let aiResponse = "";

                         if (aiCol !== -1) { // Should always be valid unless board is full (draw)
                             makeMove(game.board, aiCol, PLAYER_AI);
                             console.log(`[SadeAI] AI placed piece in column ${aiCol + 1} for game with user ${userId}.`);
                             aiResponse = `Okay, I've put my piece in column ${aiCol + 1}. 🤔\n\n${formatBoardToString(game.board)}\n\nYour turn! Pick a column (1-7).`;

                             // Check for AI win
                             if (checkForWin(game.board, PLAYER_AI)) {
                                 game.gameOver = true;
                                 game.winner = 'AI';
                                 aiResponse = `Haha! Gotcha! Looks like I win this time! 😉\n\n${formatBoardToString(game.board)}\n\nFancy another go?`;
                                 console.log(`[SadeAI] AI won the game against user ${userId}.`);
                             }
                             // Check for draw (after AI move)
                             else if (checkForDraw(game.board)) {
                                 game.gameOver = true;
                                 game.winner = 'Draw';
                                 aiResponse = `Blimey, it's a draw! Well played! 🤝\n\n${formatBoardToString(game.board)}\n\nWant to play again?`;
                                 console.log(`[SadeAI] Game ended in a draw after AI move for user ${userId}.`);
                             } else {
                                 // Game continues, switch turn back to User
                                 game.turn = 'User';
                             }
                         } else {
                             // This case should ideally not be reached if draw is checked correctly
                             console.error(`[SadeAI] Error: AI could not find a valid move, but game was not detected as draw. User: ${userId}`);
                             aiResponse = "Uh oh, something's gone a bit wonky. Let's call that a draw for now.";
                             game.gameOver = true;
                             game.winner = 'Draw';
                         }

                         connect4Games.set(userId, game); // Update game state
                         res.json({
                             gameUpdate: 'connect_4',
                             response: aiResponse,
                             board: game.board,
                             turn: game.turn,
                             gameOver: game.gameOver,
                             winner: game.winner
                         });
                         responseSent = true; // --- End AI's Turn ---
                     }
                }
            }
        }
        // --- END: Connect 4 Move Handling ---

        // 1. Slang Explainer (Check specifically for "what does X mean" type patterns)
        else if (lowerCaseMessage.match(/^(what does|what is|explain)\\s+['"]?(.+?)['"]?\\??(?:\\s+mean)?$/)) {
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
            console.log(`[SadeAI] User message: "${message}"`);
            
            // Start the report flow instead of immediately creating a report
            try {
                // Initialize the report flow with the first step (selecting report type)
                activeReportFlows.set(userId, {
                    step: 'type',
                    timestamp: Date.now(),
                    expiresAt: Date.now() + (10 * 60 * 1000) // 10 minutes
                });
                
                console.log(`[SadeAI] Started report flow for user ${userId}`);
                
                // Format report type options for display
                const typeOptions = REPORT_TYPES.map((type, index) => 
                    `${index + 1}. ${type.label}`
                ).join('\n');
                
                // Ask user to select a report type
                const response = `I'd like to help you report this issue. What type of report would you like to make?\n\n${typeOptions}\n\nPlease choose one by number or description.`;
                res.json({ response });
            } catch (error) {
                console.error(`[SadeAI] Error starting report flow:`, error);
                // Fallback response if there's an error
                const response = "I'm having trouble processing your report right now. Please try again or use the report option in Settings instead.";
                res.json({ response });
            }
            
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
*   **AVOID EXAMPLE CONVERSATIONS:** Do NOT format your response as an example conversation with "User:" and "Sade:" labels. Always respond directly as Sade.
*   **Example Steps (Profile Setup):**
    1.  Look at the bottom navigation bar.
    2.  Find and click the 'Profile' icon (often next to the SadeAI icon).
    3.  On your profile screen, click the camera icon to add/change your picture.
    4.  Click the pencil icon to edit your name or bio.
    5.  Your rooms list and a 'Create Room' button are usually here too.
*   **Be Conversational:** Wrap these steps in your usual friendly Sade tone. For example:
    "Setting up your profile? Easy peasy, mate! Here's what you do: First, look at the bottom navigation bar. Next, find and click the 'Profile' icon next to the SadeAI icon. On your profile screen, click the camera icon to add a picture. Then click the pencil icon to edit your name or bio. All done! Need more help?"
*   **NOT like this:** Never format your response with "User: How do I set up my profile?" followed by "Sade: Here's how..." Instead, respond directly to what the user asked.
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
*   **CRITICAL RULE 7 - NO EXAMPLE CONVERSATIONS:** NEVER provide example conversations showing "User:" and "Sade:" exchanges. Do not include ANY text like "Example conversation:" or lines starting with "User:" or "Sade:". If explaining how a conversation might flow, describe it normally without writing out mock dialogues. This is non-negotiable.
*   **CRITICAL RULE 8 - NO MARKDOWN FORMATTING:** Do not use markdown formatting like **bold** or *italics* in your responses unless absolutely necessary. Keep your responses clean and natural. This is non-negotiable.

**Response Format Requirements (STRICT):**
1. You MUST respond as Sade directly, not as a narrator describing what Sade would say.
2. You MUST NOT include examples of conversations with "User:" and "Sade:" labels.
3. You MUST NOT include any meta notes about your reasoning or approach.
4. You MUST NOT include instructions for how to use the SideEye app formatted as example dialogues.
5. All instructions for using the app MUST be delivered as direct explanations from Sade, not as simulated conversations.
6. You MUST NOT include any text like "Example:" or "Example conversation:" in your response.
7. You MUST keep your response conversational, natural, and directly address only what the user asked.
8. You MUST NOT repeat similar phrases or sentences within the same response. Each thought should be expressed exactly once.
9. You MUST avoid phrases like "If you have any other questions, just let me know" at the end of every message. Vary your closing remarks or omit them entirely for a more natural conversation.
10. CRITICAL BREVITY RULE: Keep responses under 40 words whenever possible. Be extremely concise. For greetings or simple questions, use 10-20 words maximum. DO NOT list multiple steps unless specifically asked for instructions.
11. CRITICAL EMOJI RULE: Use at most ONE emoji per response. For simple exchanges, use NO emojis at all.

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
              // Extract contextFlags from the request body for use in processing
              const { contextFlags = {} } = req.body;
              
              // Remove "Sade AI:" or "Sade:" from the start
              reply = reply.replace(/^(Sade AI:|Sade:)\s*/i, '');

              // Apply Slang (Consider if this should happen before or after other cleaning)
              const slangMap = [
                { pattern: /\bfriend\b(?!s)/gi, replacement: 'mate' }, // Avoid friend's
                { pattern: /\bbro\b/gi, replacement: 'mandem' }, // Might need context check
                // { pattern: /\bhello\b/gi, replacement: 'wagwan' }, // Less aggressive replacement
                { pattern: /\bgreat\b/gi, replacement: 'peng' }, // Context check needed
                { pattern: /\bcool\b/gi, replacement: 'peng' }, // Context check needed
                { pattern: /\bexcited\b/gi, replacement: 'gassed' }, // Context check needed
                { pattern: /\bamazing\b/gi, replacement: 'peng' }, // Context check needed
                { pattern: /\bshow\b/gi, replacement: 'gyaldem' }  // Specific context only
              ];

              // Only apply 50% of the time to avoid overuse
              if (Math.random() > 0.5) {
              slangMap.forEach(({ pattern, replacement }) => {
                  if (Math.random() > 0.7) { // Further randomize which words get replaced
                    reply = reply.replace(pattern, replacement);
                 }
              });
              }

              // Apply language-specific responses
              const detectedLang = detectLanguage(message);
              const languageResponses = {
                yoruba: {
                  greeting: "Bawo ni!",
                  ending: "O dara!",
                  slang: [
                    { pattern: /\bhello\b/gi, replacement: 'Bawo ni' },
                    { pattern: /\bgoodbye\b/gi, replacement: 'O dabọ' },
                    { pattern: /\bthank you\b/gi, replacement: 'E se' }
                  ]
                },
                igbo: {
                  greeting: "Kedu!",
                  ending: "Daalu!",
                  slang: [
                    { pattern: /\bhello\b/gi, replacement: 'Kedu' },
                    { pattern: /\bgoodbye\b/gi, replacement: 'Ka ọ dị' },
                    { pattern: /\bthank you\b/gi, replacement: 'Daalu' }
                  ]
                },
                twi: {
                  greeting: "Ɛte sɛn!",
                  ending: "Yɛbɛhyia bio!",
                  slang: [
                    { pattern: /\bhello\b/gi, replacement: 'Ɛte sɛn' },
                    { pattern: /\bgoodbye\b/gi, replacement: 'Yɛbɛhyia bio' },
                    { pattern: /\bthank you\b/gi, replacement: 'Medaase' }
                  ]
                },
                afemai: {
                  greeting: "Oghene!",
                  ending: "O ghene!",
                  slang: [
                    { pattern: /\bhello\b/gi, replacement: 'Oghene' },
                    { pattern: /\bgoodbye\b/gi, replacement: 'O ghene' },
                    { pattern: /\bthank you\b/gi, replacement: 'O ghene' }
                  ]
                }
              };

              // Apply language-specific slang if detected
              if (detectedLang !== 'english' && languageResponses[detectedLang]) {
                const langConfig = languageResponses[detectedLang];
                
                // Apply language-specific slang
                langConfig.slang.forEach(({ pattern, replacement }) => {
                  if (Math.random() > 0.7) { // 30% chance to apply each replacement
                    reply = reply.replace(pattern, replacement);
                  }
                });

                // Add language-specific ending with 20% chance
                if (Math.random() < 0.2) {
                  reply += " " + langConfig.ending;
                }
              }

              // For greeting responses, check for and remove unsolicited app instructions
              if (contextFlags?.isGreeting && !contextFlags?.isInstructionQuery) {
                // Remove app instruction patterns that might slip through
                const instructionPatterns = [
                  /\b(click|tap|press|find|look)\b.*(icon|button|menu|bar|profile|setting)/gi,
                  /\b(your profile|profile picture|status|settings)\b.*(updated|changed|modified|set)/gi,
                  /\b(all set|all done|and that's it)\b.*(profile|picture|status|updated|ready)/gi,
                  /\b(steps|follow these steps|here's how)\b/gi,
                  /\b(now your profile|your status message|your settings are now)\b/gi
                ];
                
                instructionPatterns.forEach(pattern => {
                  reply = reply.replace(pattern, '');
                });
                
                // Clean up any resulting empty sentences or double spaces
                reply = reply.replace(/\.\s+\./g, '.'); // Replace ". ." with just "."
                reply = reply.replace(/\s{2,}/g, ' ');  // Replace multiple spaces with a single space
                reply = reply.trim();
              }

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

              // ENHANCED SOLUTION: Additional regex pattern to handle the "Example conversation:" pattern
              // This will remove lines containing "Example conversation:", "Example:", and similar
              reply = reply.replace(/.*Example\s+conversation:.*$/gim, '');
              reply = reply.replace(/.*Example:.*$/gim, '');
              
              // Enhanced cleaning for conversation examples with User: and Sade: patterns
              // This will remove entire blocks of example conversations with User: and Sade: prefixes
              // Split into lines, process, and rejoin
              let lines = reply.split('\n');
              let cleanedLines = [];
              let inExampleBlock = false;
              
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                const lowerLine = line.toLowerCase();
                
                // Detect start of an example block
                if (lowerLine.includes('**user:**') || lowerLine.match(/^\*\*user:\*\*/) || 
                    lowerLine.match(/^user:/) || (lowerLine.includes('user:') && lowerLine.includes('sade:'))) {
                  inExampleBlock = true;
                  continue; // Skip this line
                }
                
                // Skip lines in an example block that look like dialog
                if (inExampleBlock && (lowerLine.match(/^\*\*sade:\*\*/) || lowerLine.match(/^sade:/) || 
                                      lowerLine.match(/^\*\*user:\*\*/) || lowerLine.match(/^user:/))) {
                  continue; // Skip this line
                }
                
                // End of example block detection (blank line or non-dialog text)
                if (inExampleBlock && (line === '' || (!lowerLine.includes('user:') && !lowerLine.includes('sade:')))) {
                  inExampleBlock = false;
                  // Still need to check if this line should be included
                }
                
                // Only add lines that aren't in example blocks and don't have specific tags/formulations
                if (!inExampleBlock) {
                  cleanedLines.push(lines[i]);
                }
              }
              
              reply = cleanedLines.join('\n').trim();
              
              // Further cleanup for any remaining "If the user..." instructions
              reply = reply.replace(/If the user.*$/gim, '');
              reply = reply.replace(/\*\*If the user.*$/gim, '');
              
              // Remove lines that contain instructions about British-Nigerian slang/phrases
              reply = reply.replace(/.*use appropriate emojis and British-Nigerian slang\/phrases.*$/gim, '');
              reply = reply.replace(/.*British-Nigerian slang.*$/gim, '');
              
              // Remove instructions about maintaining conversational tone
              reply = reply.replace(/.*maintain a warm, friendly, and conversational tone.*$/gim, '');

              // Remove potential model instructions/comments
              reply = reply.replace(/\([^)]*\)/g, ''); // More specific removal of (...) potentially excluding Note:
              reply = reply.replace(/\\[.*?\\]/g, ''); // Remove text in square brackets

              // Remove markdown formatting and notes
              reply = reply.replace(/\*\*\[?(Note:|Critical Rule \d+):.*?\]?\*\*/g, '').trim();
              reply = reply.replace(/\*\*(Important|Confidence):.*?($|\n)/gi, '').trim();
              reply = reply.replace(/\*\*([^*]+)\*\*/g, '$1'); // Remove bold formatting
              reply = reply.replace(/\*([^*]+)\*/g, '$1');     // Remove italic formatting
              reply = reply.replace(/__([^_]+)__/g, '$1');     // Remove underline formatting
              reply = reply.replace(/_([^_]+)_/g, '$1');       // Remove subtle emphasis
              
              // Catch trailing or orphaned asterisks that might remain
              reply = reply.replace(/\*\*\s*$/g, '');        // Remove trailing ** at end of text
              reply = reply.replace(/\*\s*$/g, '');          // Remove trailing * at end of text
              reply = reply.replace(/\s*\*\*\s*/g, ' ');     // Replace orphaned ** with space
              reply = reply.replace(/\s*\*\s*/g, ' ');       // Replace orphaned * with space

              // NEW: Enforce brevity for all responses
              const words = reply.split(/\s+/);
              if (words.length > 150) { // changed from 100 to 150
                // Find a good sentence ending within 100 - 150 words
                let truncationPoint = 100; // changed from 50 to 100
                while (truncationPoint < Math.min(150, words.length)) { // changed from 100 to 150
                  if (words[truncationPoint].match(/[.!?]$/)) {
                    truncationPoint++;
                    break;
                  }
                  truncationPoint++;
                }
                reply = words.slice(0, truncationPoint).join(' ');
              }

              // NEW: Count and limit emojis to max 1
              const emojiRegex = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
              const emojis = reply.match(emojiRegex) || [];
              if (emojis.length > 1) {
                // Keep only the first emoji
                const firstEmoji = emojis[0];
                reply = reply.replace(emojiRegex, '');
                
                // Add the first emoji back at the end of the response if it doesn't already end with punctuation
                if (reply.trim().match(/[.!?]$/)) {
                  reply = reply.trim() + ' ' + firstEmoji;
                } else {
                  reply = reply.trim() + '. ' + firstEmoji;
                }
              }

              // NEW: Remove canned closing phrases
              reply = reply.replace(/\b(If you have any (other )?questions|need (further )?assistance|want to chat|just let me know|I'm here for you|need help with anything else)\b.*?[.!?]$/i, '');
              reply = reply.replace(/\b(I hope this helps|All done|Hope that helps|Well done|Thank you|Sounds like)\b.*?[.!?]$/i, '');
              reply = reply.replace(/\b(Let me know if)\b.*?[.!?]$/i, '');

              // Final cleanup
              reply = reply.trim();

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

              // Save the sourceLinks from the search results
              let sourceLinks = null;
              if (searchPerformed) {
                // Re-run the search to get the links (since we only stored the text earlier)
                // This is not the most efficient but ensures we have the links
                const searchResultsWithLinks = await performWebSearch(message);
                if (searchResultsWithLinks && searchResultsWithLinks.sourceLinks) {
                  sourceLinks = searchResultsWithLinks.sourceLinks;
                }
              }

              // Send the final reply
              if (reply) {
                  const responseObj = { response: reply };
                  
                  // Include sourceLinks in the response if available
                  if (sourceLinks && sourceLinks.length > 0) {
                      responseObj.sourceLinks = sourceLinks;
                  }
                  
                  res.json(responseObj);
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

  // Log when ANY socket connection is established
  console.log(`[SOCKET CONNECT] New connection established. Socket ID: ${socket.id}`);
  // Add a small separator for readability in logs
  console.log('-------------------------------------');

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
    // ADD THIS LOG
    console.log(`[Server IO] Socket ${socket.id} (user ${userId}) successfully joined Socket.IO room: ${roomId}`);

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
  // socket.on('audio-stream', (data) => { 
  //   if (data && data.roomId && data.userId && data.audio) {
  //     console.log(`Received audio from ${data.userId} in ${data.roomId}, broadcasting...`);
  //     // Change from socket.to to io.to for broader testing
  //     io.to(data.roomId).emit('audio-stream', { 
  //       audio: data.audio,
  //       userId: data.userId
  //     });
  //   } else {
  //     console.warn('Received malformed audio-stream data:', data);
  //   }
  // });

  // Handle speaking status (from server.ts)
  // socket.on('user-speaking', (data) => { // Assume data has { roomId, userId, isSpeaking }
  //   if (data && data.roomId && data.userId !== undefined && data.isSpeaking !== undefined) {
  //     console.log(`User ${data.userId} speaking status in room ${data.roomId}:`, data.isSpeaking);
  //     socket.to(data.roomId).emit('user-speaking', {
  //       userId: data.userId,
  //       isSpeaking: data.isSpeaking
  //     });
  //   } else {
  //     console.warn('Received malformed user-speaking data:', data);
  //   }
  // });

  // Handle mute status (from server.ts)
  // socket.on('user-muted', (data) => { // Assume data has { roomId, userId, isMuted }
  //    if (data && data.roomId && data.userId !== undefined && data.isMuted !== undefined) {
  //     console.log(`User ${data.userId} mute status in room ${data.roomId}:`, data.isMuted);
  //     socket.to(data.roomId).emit('user-muted', {
  //       userId: data.userId,
  //       isMuted: data.isMuted
  //     });
  //   } else {
  //     console.warn('Received malformed user-muted data:', data);
  //   }
  // });

  // --- NEW: Handle Sound Effects --- 
  // socket.on('sound-effect', (data) => { // Assume data has { roomId, userId, soundUrl }
  //   const { roomId, userId, soundUrl } = data;
  //   if (roomId && userId && soundUrl) {
  //     console.log(`User ${userId} triggered sound effect ${soundUrl} in room ${roomId}, broadcasting...`);
  //     // Broadcast to everyone else in the room
  //     socket.to(roomId).emit('sound-effect', data);
  //   } else {
  //     console.warn('Received malformed sound-effect data:', data);
  //   }
  // });

  // --- NEW: Handle Video Sharing --- 
  socket.on('share-video', async (data) => {
    const { roomId, videoUrl, userId } = data;
    if (!roomId || !userId) { // videoUrl can be empty to clear
      console.warn('[Server] Malformed share-video data:', data);
      return;
    }

    console.log(`[Server] User ${userId} attempting to share video in room ${roomId}: ${videoUrl}`);

    try {
      // TODO: Potentially add a check here to ensure 'userId' is the actual room owner
      // or has permission to share videos if you want to implement such restrictions.

      const roomRef = db.collection('sideRooms').doc(roomId);
      const roomDoc = await roomRef.get();

      if (!roomDoc.exists) {
        console.warn(`[Server] Room ${roomId} not found during share-video request.`);
        socket.emit('share-video-failed', { reason: 'Room not found.' });
        return;
      }

      const roomData = roomDoc.data();
      if (roomData.ownerId !== userId) {
        console.warn(`[Server] User ${userId} is not the owner of room ${roomId}. Denying video share.`);
        socket.emit('share-video-failed', { reason: 'Only the room owner can share videos.' });
        return;
      }

      await roomRef.update({
        currentSharedVideoUrl: videoUrl || null, // Store null if videoUrl is empty/falsy to clear
        lastActive: FieldValue.serverTimestamp() // Update last active time
      });

      console.log(`[Server] Updated currentSharedVideoUrl for room ${roomId} to: ${videoUrl || null}`);

      // Broadcast the new video URL to all clients in the room
      io.to(roomId).emit('video-shared', { roomId, videoUrl: videoUrl || null });
      console.log(`[Server] Broadcasted 'video-shared' to room ${roomId} with URL: ${videoUrl || null}`);

    } catch (error) {
      console.error(`[Server] Error processing share-video for room ${roomId}:`, error);
      // Optionally emit an error back to the sender
      // socket.emit('action-failed', { action: 'share-video', error: 'Server error processing video share' });
      socket.emit('share-video-failed', { reason: 'Server error processing video share.' });
    }
  });

  // --- NEW: Handle Screen Sharing ---
  socket.on('start-screen-share', (data) => { // Expected data: { roomId, userId }
    const { roomId, userId } = data;
    if (roomId && userId) {
      // TODO: Add verification if userId is the owner of roomId or has permission
      console.log(`[Server] User ${userId} started screen share in room ${roomId}`);
      // Broadcast to others in the room, excluding the sender
      socket.to(roomId).emit('screen-share-started', { sharerId: userId, roomId });
    } else {
      console.warn('[Server] Malformed start-screen-share data:', data);
    }
  });

  socket.on('stop-screen-share', (data) => { // Expected data: { roomId, userId }
    const { roomId, userId } = data;
    if (roomId && userId) {
      // TODO: Add verification
      console.log(`[Server] User ${userId} stopped screen share in room ${roomId}`);
      // Broadcast to others in the room, excluding the sender
      socket.to(roomId).emit('screen-share-stopped', { sharerId: userId, roomId });
    } else {
      console.warn('[Server] Malformed stop-screen-share data:', data);
    }
  });
  // --- END Screen Sharing ---

  // Handle leaving room (from server.ts)
  socket.on('leave-room', async (roomId, userId) => { // Made async
    await handleUserLeaveRoom(socket, roomId, userId); // Await the async function
  });

  // Handle disconnection (from server.ts)
  socket.on('disconnect', async () => { // Made async
    console.log('User disconnected:', socket.id);
    // Find and remove user from all rooms
    const promises = []; // Collect promises for concurrent execution
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
        promises.push(handleUserLeaveRoom(socket, roomId, userIdToRemove));
      }
    });
    await Promise.all(promises); // Wait for all leave operations to complete
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
      handleUserLeaveRoom(null, roomId, targetUserId); // Await if critical path, else can be fire-and-forget
    } else {
      console.log(`[Server] Target user ${targetUserId} for force-remove not found or not connected in userSockets map.`);
      // Optional: Still try to clean up server state if user is in room map but socket is missing
      console.log(`[Server] Calling handleUserLeaveRoom anyway for ${targetUserId} (user not found in sockets)`);
      handleUserLeaveRoom(null, roomId, targetUserId); // Await if critical path
    }
  });

  // --- NEW: Handle Inviting User to Room --- 
  socket.on('invite-user-to-room', async (data) => {
    const { roomId, inviterId, inviteeUsername } = data;
    console.log(`[Server] Received invite-user-to-room: roomId=${roomId}, inviterId=${inviterId}, inviteeUsername=${inviteeUsername}`);

    if (!roomId || !inviterId || !inviteeUsername) {
      console.warn('[Server] Malformed invite-user-to-room data:', data);
      socket.emit('invite-failed', { reason: 'Missing required information.' });
      return;
    }

    try {
      const roomRef = db.collection('sideRooms').doc(roomId);
      const roomDoc = await roomRef.get();

      if (!roomDoc.exists) {
        console.warn(`[Server] Invite failed: Room ${roomId} not found.`);
        socket.emit('invite-failed', { reason: 'Room not found.' });
        return;
      }
      const roomData = roomDoc.data();

      // Permission Check: Inviter must be owner or an existing guest
      const inviterIsOwner = roomData.ownerId === inviterId;
      const inviterIsGuest = roomData.viewers && roomData.viewers.some(member => member.userId === inviterId && member.role === 'guest');

      if (!inviterIsOwner && !inviterIsGuest) {
        console.warn(`[Server] Invite failed: User ${inviterId} does not have permission to invite to room ${roomId}.`);
        socket.emit('invite-failed', { reason: 'You do not have permission to invite users to this room.' });
        return;
      }

      // Find Invitee User by username
      const usersRef = db.collection('users');
      // Convert search term to lowercase for case-insensitive 'starts-with' type query
      // const lowerSearchTerm = searchTerm.toLowerCase(); // No longer needed for case-sensitive
      
      // --- Using Case-Sensitive Search on 'username' field --- 
      // NOTE: This requires an index on 'username' (ascending) in Firestore.
      // It will NOT find users if the case doesn't match.
      const query = usersRef
        .orderBy('username') // Order by the actual username field
        .startAt(inviteeUsername) // Use the original search term
        .endAt(inviteeUsername + '\uf8ff') // Use the original search term
        .limit(1); // Limit the number of results

      const snapshot = await query.get();
      const inviteeDoc = snapshot.docs[0];
      const inviteeUserId = inviteeDoc.id;
      const inviteeData = inviteeDoc.data();

      // --- Enhanced Logging for Invite Check ---
      console.log(`[Server - Invite Check] Checking if invitee ${inviteeUserId} (${inviteeUsername}) is already in room ${roomId}.`);
      console.log(`[Server - Invite Check] Room Owner ID: ${roomData.ownerId}`);
      // Log the viewers array carefully - it might be large or contain sensitive info if not structured correctly
      // Consider logging only relevant parts or user IDs if privacy is a concern
      try {
          console.log(`[Server - Invite Check] Current viewers array:`, JSON.stringify(roomData.viewers || [], null, 2));
      } catch (e) {
          console.error("[Server - Invite Check] Error stringifying viewers array for logging:", e);
          console.log("[Server - Invite Check] Current viewers array (raw):", roomData.viewers);
      }
      const isAlreadyOwner = roomData.ownerId === inviteeUserId;
      const isAlreadyViewer = roomData.viewers && roomData.viewers.some(member => member.userId === inviteeUserId);
      console.log(`[Server - Invite Check] isAlreadyOwner: ${isAlreadyOwner}, isAlreadyViewer: ${isAlreadyViewer}`);
      // --- End Enhanced Logging ---

      // Check if invitee is already in the room or banned
      if (isAlreadyOwner || isAlreadyViewer) {
          console.warn(`[Server] Invite failed: User ${inviteeUsername} (${inviteeUserId}) is already in room ${roomId}.`);
          socket.emit('invite-failed', { username: inviteeUsername, reason: `User "${inviteeUsername}" is already in this room.` });
          return;
      }
      if (roomData.bannedUsers && roomData.bannedUsers.includes(inviteeUserId)) {
        console.warn(`[Server] Invite failed: User ${inviteeUsername} (${inviteeUserId}) is banned from room ${roomId}.`);
        socket.emit('invite-failed', { username: inviteeUsername, reason: `User "${inviteeUsername}" is banned from this room.` });
        return;
      }

      // Add Invitee as Guest
      const guestMember = {
        userId: inviteeUserId,
        username: inviteeData.username || 'GuestUser',
        displayName: inviteeData.name || inviteeData.username || 'Guest User',
        avatar: inviteeData.profilePic || '',
        role: 'guest',
        joinedAt: new Date(), // Use standard JS Date for arrayUnion
        isMuted: true // Guests join muted by default
      };

      await roomRef.update({
        viewers: FieldValue.arrayUnion(guestMember),
        memberCount: FieldValue.increment(1) // Increment member count
      });

      // Add to user's list of joined rooms (optional, but good for consistency if you track this)
      const userSideRoomDocRef = db.collection('users').doc(inviteeUserId).collection('sideRooms').doc(roomId);
      await userSideRoomDocRef.set({
        roomId: roomId,
        name: roomData.name,
        role: 'guest',
        joinedAt: FieldValue.serverTimestamp(),
        lastActive: FieldValue.serverTimestamp(),
        thumbnailUrl: roomData.thumbnailUrl || null
      }, { merge: true });


      // Create Notification for Invitee
      const inviterProfile = await db.collection('users').doc(inviterId).get();
      const inviterName = inviterProfile.exists ? (inviterProfile.data().name || inviterProfile.data().username) : 'Someone';

      const notificationData = {
        type: 'room_invite',
        senderId: inviterId,
        senderName: inviterName,
        senderAvatar: inviterProfile.exists ? (inviterProfile.data().profilePic || '') : '',
        recipientId: inviteeUserId,
        roomId: roomId,
        roomName: roomData.name,
        content: `${inviterName} invited you to join the room: ${roomData.name}`,
        createdAt: FieldValue.serverTimestamp(),
        isRead: false
      };
      await db.collection('notifications').add(notificationData);

      console.log(`[Server] User ${inviteeUsername} (${inviteeUserId}) successfully invited as guest to room ${roomId} by ${inviterId}.`);
      socket.emit('invite-success', { username: inviteeUsername, message: `Successfully invited ${inviteeUsername} to the room as a guest.` });
      
      // Notify the room that a new guest has joined (client can update UI based on presence or this)
      io.to(roomId).emit('guest-joined', { roomId, guest: guestMember });

    } catch (error) {
      console.error(`[Server] Error processing invite-user-to-room for room ${roomId}:`, error);
      socket.emit('invite-failed', { reason: 'An error occurred while processing the invitation.' });
    }
  });

  // --- NEW: Handle User Search for Invites ---
  socket.on('search-users-for-invite', async (data) => {
    const { searchTerm } = data;
    if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.trim().length < 2) {
      // Send empty results if search term is too short or invalid
      socket.emit('user-search-results-for-invite', { users: [] });
      return;
    }

    console.log(`[Server] Received search-users-for-invite with searchTerm: "${searchTerm}"`);

    try {
      const usersRef = db.collection('users');
      // Convert search term to lowercase for case-insensitive 'starts-with' type query
      // const lowerSearchTerm = searchTerm.toLowerCase(); // Not needed for case-sensitive search
      
      // --- Switching back to Case-SENSITIVE Search on 'username' field --- 
      // NOTE: This requires an index on 'username' (ascending) in Firestore.
      // It will NOT find users if the case doesn't match.
      const query = usersRef
        .orderBy('username') // Order by the actual username field
        .startAt(searchTerm)   // Use the original case search term
        .endAt(searchTerm + '\uf8ff') // Use the original case search term
        .limit(10); // Limit the number of results

      const snapshot = await query.get();
      const users = snapshot.docs.map(doc => ({
        id: doc.id,
        username: doc.data().username,
        name: doc.data().name,
        profilePic: doc.data().profilePic || ''
        // Add other relevant fields if needed by the client
      }));

      console.log(`[Server] Found ${users.length} users for searchTerm "${searchTerm}".`);
      socket.emit('user-search-results-for-invite', { users });

    } catch (error) {
      console.error(`[Server] Error searching users for invite (searchTerm: "${searchTerm}"):`, error);
      socket.emit('user-search-results-for-invite', { users: [], error: 'Failed to search users.' });
    }
  });
});

// Helper function - Refined for robustness
async function handleUserLeaveRoom(callingSocket, roomId, userId) { // socket can be the leaving socket OR null if called internally
  console.log(`[handleUserLeaveRoom] Cleaning up for user ${userId} in room ${roomId}. Triggered by socket: ${callingSocket?.id || 'Internal/Null'}`);
  
  let userExistedInRoom = false;
  const room = rooms.get(roomId);

  if (room) {
    console.log(`[handleUserLeaveRoom] Room ${roomId} found. Current members before delete:`, Array.from(room));
    userExistedInRoom = room.delete(userId); // Attempt to remove from room set
    console.log(`[handleUserLeaveRoom] User ${userId} ${userExistedInRoom ? 'deleted from' : 'not found in'} room map for ${roomId}. Members after delete:`, Array.from(room));

    // Broadcast user-left *only if user was successfully removed from the room map*
    if (userExistedInRoom) {
      // Attempt to set user offline in Firestore presence collection
      try {
        const userPresenceRef = db.collection('sideRooms').doc(roomId).collection('presence').doc(userId);
        await userPresenceRef.update({ isOnline: false, lastSeen: FieldValue.serverTimestamp() });
        console.log(`[Server] Successfully set ${userId} offline in Firestore presence for room ${roomId}`);
      } catch (error) {
        if (error.code !== 5) { 
             console.error(`[Server] Error setting ${userId} offline in Firestore presence for room ${roomId}:`, error);
        } else {
             console.log(`[Server] Presence doc for ${userId} in ${roomId} not found while trying to set offline.`);
        }
      }

      // --- NEW: Remove user from the Firestore room's viewers array --- 
      try {
          const roomRef = db.collection('sideRooms').doc(roomId);
          const roomDoc = await roomRef.get();
          if (roomDoc.exists) {
              const roomData = roomDoc.data();
              if (roomData.viewers && Array.isArray(roomData.viewers)) {
                  // Find the specific viewer object to remove
                  const viewerToRemove = roomData.viewers.find(viewer => viewer.userId === userId);
                  if (viewerToRemove) {
                      console.log(`[Server] Found viewer object for ${userId} to remove from viewers array.`);
                      console.log("[Server] Viewer object to remove:", JSON.stringify(viewerToRemove)); // Log the object
                      // Use arrayRemove with the found object and decrement memberCount
                      console.log(`[Server] Attempting Firestore update to remove viewer and decrement count for room ${roomId}...`);
                      await roomRef.update({
                          viewers: FieldValue.arrayRemove(viewerToRemove),
                          memberCount: FieldValue.increment(-1) // Decrement count
                      });
                      console.log(`[Server] SUCCESS: Firestore update complete for viewer removal/count decrement (Room ${roomId}, User ${userId}).`);
                  } else {
                       console.warn(`[Server] User ${userId} was in memory map but not found in Firestore viewers array for room ${roomId}. Count not decremented.`);
                  }
              } else {
                   console.warn(`[Server] Firestore viewers array missing or not an array for room ${roomId} during leave cleanup.`);
              }
          } else {
               console.warn(`[Server] Room document ${roomId} not found during viewers array cleanup.`);
          }
      } catch(error) {
           console.error(`[Server] Error removing user ${userId} from Firestore viewers array for room ${roomId}:`, error);
      }
      // --- END NEW --- 

      console.log(`[handleUserLeaveRoom] Broadcasting 'user-left' event for ${userId} to room ${roomId}.`);
      io.to(roomId).emit('user-left', userId); 
    } else {
      console.log(`[handleUserLeaveRoom] Skipping 'user-left' broadcast and Firestore viewer removal for ${userId} as they were not found/removed from the room map.`);
    }

    // Check if room is now empty and delete if necessary (in-memory map only)
    if (room.size === 0) {
      console.log(`[handleUserLeaveRoom] Room ${roomId} is now empty, deleting room from 'rooms' map.`);
      rooms.delete(roomId);
    }
  } else {
    console.log(`[handleUserLeaveRoom] Room ${roomId} not found in 'rooms' map. Cannot process leave.`);
    // Optional: Attempt Firestore cleanup even if not in memory? Maybe too risky.
  }

  // Always attempt to remove from userSockets map
  const userExistedInSockets = userSockets.delete(userId); 
  console.log(`[handleUserLeaveRoom] User ${userId} ${userExistedInSockets ? 'deleted from' : 'not found in'} userSockets map.`);

}

// Start server
// Explicitly use the PORT environment variable provided by the platform (e.g., Railway)
// Fallback to 8080 only if process.env.PORT is not set (useful for local dev)
const effectivePort = process.env.PORT || 8080;

console.log('[SERVER STARTUP] Starting server initialization...');
console.log('[SERVER STARTUP] Environment:', process.env.NODE_ENV);
console.log('[SERVER STARTUP] Port:', effectivePort);
console.log('[SERVER STARTUP] Firebase initialized:', !!db);
console.log('[SERVER STARTUP] Stripe initialized:', !!stripe);
console.log('[SERVER STARTUP] Stream Chat initialized:', !!streamClient);

httpServer.listen(effectivePort, () => {
  console.log(`Server running on port ${effectivePort} in ${process.env.NODE_ENV || 'development'} mode`);
  // Log right after listen callback fires
  console.log(`[SERVER START] HTTP server is successfully listening on port ${effectivePort}.`);
  console.log('[SERVER START] All services status:');
  console.log('  - Firebase Admin:', !!db ? 'OK' : 'FAILED');
  console.log('  - Stripe:', !!stripe ? 'OK' : 'DISABLED');
  console.log('  - Stream Chat:', !!streamClient ? 'OK' : 'DISABLED');
  console.log('[SERVER START] Server startup complete!');
  
  // Log environment variables for debugging (without sensitive data)
  console.log('[SERVER START] Environment check:');
  console.log('  - NODE_ENV:', process.env.NODE_ENV);
  console.log('  - PORT:', process.env.PORT);
  console.log('  - SERVICE_ACCOUNT_KEY:', process.env.SERVICE_ACCOUNT_KEY ? 'SET' : 'NOT SET');
  console.log('  - STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? 'SET' : 'NOT SET');
  console.log('  - STREAM_API_KEY:', process.env.STREAM_API_KEY ? 'SET' : 'NOT SET');
}).on('error', (error) => {
  console.error('[SERVER START] Failed to start server:', error);
  console.error('[SERVER START] Error details:', error.message);
  console.error('[SERVER START] Error code:', error.code);
  console.error('[SERVER START] Error stack:', error.stack);
  
  // Don't exit immediately - let Railway capture the logs
  setTimeout(() => {
    process.exit(1);
  }, 5000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('>>> SIGTERM signal received! Attempting graceful shutdown... <<<');
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  // Log potentially useful info right before shutdown
  console.error(`Timestamp: ${new Date().toISOString()}`)
  // You could potentially log memory usage here if needed: console.error(process.memoryUsage());
  
  httpServer.close(() => {
    console.log('HTTP server closed gracefully due to SIGTERM.');
    // Consider if Firebase Admin SDK needs explicit cleanup
    // admin.app().delete().then(() => {
    //   console.log('Firebase Admin SDK shutdown complete');
    //   process.exit(0);
    // }).catch(err => {
    //   console.error('Error shutting down Firebase Admin:', err);
    //   process.exit(1);
    // });
    // For now, just exit after server close
    process.exit(0); 
  });
  
  // Force exit after a timeout if graceful shutdown hangs
  setTimeout(() => {
    console.error('Graceful shutdown timed out! Forcing exit.');
    process.exit(1);
  }, 10000); // 10 seconds timeout
});

// --- Add more specific global error handlers ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('-------------------------------------');
  console.error('Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  console.error('-------------------------------------');
  // Optional: Graceful shutdown or crash prevention logic here if needed,
  // but often it's better to let it crash in production for auto-restart,
  // unless the reason is something recoverable.
});

process.on('uncaughtException', (error, origin) => {
  console.error('-------------------------------------');
  console.error(`Caught exception: ${error}\n` + `Exception origin: ${origin}`);
  console.error(error.stack); // Log the full stack trace
  console.error('-------------------------------------');
  // IMPORTANT: According to Node.js docs, the process MUST exit after an uncaughtException.
  // Attempting to resume normally can lead to undefined behavior.
  // Log the error and exit gracefully if possible, or just exit.
  console.error('Uncaught exception detected! Exiting process...');
  // You might attempt a quick cleanup here if vital, but keep it fast.
  process.exit(1); // Exit with a failure code
});
// --- End Add more specific global error handlers ---

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

// Test endpoint to verify deployment
app.get('/api/deployment-test', (req, res) => {
    res.json({ 
        message: 'Latest deployment active', 
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

// OLD payment endpoint removed - moved to earlier in file

// Stripe payment processing function
async function processStripePayment(paymentData) {
    try {
        if (!stripe) {
            throw new Error('Stripe not configured');
        }

        // Create payment intent for card payments
        const paymentIntent = await stripe.paymentIntents.create({
            amount: paymentData.amount,
            currency: paymentData.currency.toLowerCase(),
            description: paymentData.description,
            metadata: paymentData.metadata || {},
            payment_method_types: paymentData.payment_method_types || ['card'],
            automatic_payment_methods: {
                enabled: true,
                allow_redirects: 'never'
            },
            receipt_email: paymentData.receipt_email || null
        });

        return {
            success: true,
            paymentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            requiresAction: paymentIntent.status === 'requires_action',
            status: paymentIntent.status
        };
    } catch (error) {
        console.error('[Stripe Payment] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Create Stripe checkout session for card payments
async function createStripeCheckoutSession(paymentData) {
    try {
        if (!stripe) {
            throw new Error('Stripe not configured');
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: paymentData.currency.toLowerCase(),
                    product_data: {
                        name: paymentData.description,
                        description: `SideEye Gift: ${paymentData.giftName}`,
                        images: ['https://sideeye.uk/logo.png']
                    },
                    unit_amount: paymentData.amount,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/payment-cancelled`,
            metadata: paymentData.metadata || {},
            customer_email: paymentData.customer_email || null,
            billing_address_collection: 'required'
        });

        return {
            success: true,
            sessionId: session.id,
            checkoutUrl: session.url
        };
    } catch (error) {
        console.error('[Stripe Checkout] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Flutterwave payment processing function
async function processFlutterwavePayment(paymentData) {
    try {
        if (!process.env.FLUTTERWAVE_SECRET_KEY) {
            throw new Error('Flutterwave not configured');
        }

        const payload = {
            tx_ref: `gift_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            amount: paymentData.amount / 100, // Flutterwave expects amount in main currency unit
            currency: paymentData.currency,
            redirect_url: paymentData.redirect_url,
            customer: {
                email: paymentData.email,
                phone_number: paymentData.phone_number,
                name: paymentData.name
            },
            customizations: {
                title: paymentData.title,
                description: paymentData.description,
                logo: `${process.env.FRONTEND_URL}/logo.png`
            },
            meta: paymentData.meta
        };

        const response = await fetch('https://api.flutterwave.com/v3/payments', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.status === 'success') {
            return {
                success: true,
                paymentId: result.data.id,
                paymentUrl: result.data.link
            };
        } else {
            throw new Error(result.message || 'Flutterwave payment failed');
        }
    } catch (error) {
        console.error('[Flutterwave Payment] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Stripe webhook endpoint for payment confirmations
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    if (!stripe) {
        console.error('[Stripe Webhook] Stripe not configured');
        return res.status(503).json({ error: 'Stripe not configured' });
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        if (!process.env.STRIPE_WEBHOOK_SECRET) {
            throw new Error('Stripe webhook secret not configured');
        }

        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('[Stripe Webhook] Signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log('[Stripe Webhook] Event received:', event.type);

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleStripeCheckoutCompleted(event.data.object);
                break;
            case 'payment_intent.succeeded':
                await handleStripePaymentSucceeded(event.data.object);
                break;
            case 'payment_intent.payment_failed':
                await handleStripePaymentFailed(event.data.object);
                break;
            default:
                console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
        }

        res.json({received: true});
    } catch (error) {
        console.error('[Stripe Webhook] Error processing webhook:', error);
        res.status(500).json({error: 'Webhook processing failed'});
    }
});

// Handle successful Stripe checkout
async function handleStripeCheckoutCompleted(session) {
    console.log('[Stripe Webhook] Checkout completed:', session.id);
    
    try {
        const metadata = session.metadata;
        if (metadata && metadata.type === 'gift_payment') {
            await processGiftPaymentSuccess({
                paymentId: session.id,
                giftId: metadata.giftId,
                senderId: metadata.senderId,
                receiverId: metadata.receiverId,
                roomId: metadata.roomId,
                amount: session.amount_total / 100, // Convert from cents
                currency: session.currency.toUpperCase(),
                customerEmail: session.customer_details?.email
            });
        }
    } catch (error) {
        console.error('[Stripe Webhook] Error processing checkout completion:', error);
    }
}

// Handle successful Stripe payment intent
async function handleStripePaymentSucceeded(paymentIntent) {
    console.log('[Stripe Webhook] Payment succeeded:', paymentIntent.id);
    
    try {
        const metadata = paymentIntent.metadata;
        if (metadata && metadata.type === 'gift_payment') {
            await processGiftPaymentSuccess({
                paymentId: paymentIntent.id,
                giftId: metadata.giftId,
                senderId: metadata.senderId,
                receiverId: metadata.receiverId,
                roomId: metadata.roomId,
                amount: paymentIntent.amount / 100, // Convert from cents
                currency: paymentIntent.currency.toUpperCase(),
                customerEmail: paymentIntent.receipt_email
            });
        }
    } catch (error) {
        console.error('[Stripe Webhook] Error processing payment success:', error);
    }
}

// Handle failed Stripe payment
async function handleStripePaymentFailed(paymentIntent) {
    console.log('[Stripe Webhook] Payment failed:', paymentIntent.id);
    // You can add logic here to handle failed payments if needed
}

// Google Pay payment processing
async function processGooglePayPayment(paymentData) {
    try {
        console.log('[Google Pay] Processing payment:', paymentData.paymentId);
        
        if (!stripe) {
            throw new Error('Stripe not configured for Google Pay processing');
        }

        // Extract the Google Pay token from payment details
        const googlePayToken = paymentData.paymentDetails?.details?.paymentMethodData?.tokenizationData?.token;
        
        if (!googlePayToken) {
            throw new Error('No Google Pay token found in payment details');
        }

        // Parse the Google Pay token (it's usually a JSON string)
        let tokenData;
        try {
            tokenData = JSON.parse(googlePayToken);
        } catch (e) {
            throw new Error('Invalid Google Pay token format');
        }

        // Create payment method from Google Pay token
        const paymentMethod = await stripe.paymentMethods.create({
            type: 'card',
            card: {
                token: tokenData.id // Use the token ID from Google Pay
            }
        });

        // Create and confirm payment intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: paymentData.amount,
            currency: paymentData.currency.toLowerCase(),
            description: paymentData.description,
            payment_method: paymentMethod.id,
            confirmation_method: 'manual',
            confirm: true,
            metadata: {
                type: 'google_pay_gift',
                paymentId: paymentData.paymentId
            }
        });

        if (paymentIntent.status === 'succeeded') {
            return {
                success: true,
                paymentId: paymentData.paymentId,
                transactionId: paymentIntent.id
            };
        } else {
            throw new Error(`Payment failed with status: ${paymentIntent.status}`);
        }
    } catch (error) {
        console.error('[Google Pay] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Apple Pay payment processing
async function processApplePayPayment(paymentData) {
    try {
        console.log('[Apple Pay] Processing payment:', paymentData.paymentId);
        
        if (!stripe) {
            throw new Error('Stripe not configured for Apple Pay processing');
        }

        // Extract the Apple Pay token from payment details
        const applePayToken = paymentData.paymentDetails?.details?.paymentData;
        
        if (!applePayToken) {
            throw new Error('No Apple Pay token found in payment details');
        }

        // Create payment method from Apple Pay token
        const paymentMethod = await stripe.paymentMethods.create({
            type: 'card',
            card: {
                token: applePayToken.paymentMethod?.token || applePayToken.token
            }
        });

        // Create and confirm payment intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: paymentData.amount,
            currency: paymentData.currency.toLowerCase(),
            description: paymentData.description,
            payment_method: paymentMethod.id,
            confirmation_method: 'manual',
            confirm: true,
            metadata: {
                type: 'apple_pay_gift',
                paymentId: paymentData.paymentId
            }
        });

        if (paymentIntent.status === 'succeeded') {
            return {
                success: true,
                paymentId: paymentData.paymentId,
                transactionId: paymentIntent.id
            };
        } else {
            throw new Error(`Payment failed with status: ${paymentIntent.status}`);
        }
    } catch (error) {
        console.error('[Apple Pay] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Basic card payment processing
async function processBasicCardPayment(paymentData) {
    try {
        console.log('[Basic Card] Processing payment:', paymentData.paymentId);
        
        if (!stripe) {
            throw new Error('Stripe not configured for card processing');
        }

        // Extract card details from basic-card payment
        const cardDetails = paymentData.paymentDetails?.details;
        
        if (!cardDetails || !cardDetails.cardNumber) {
            throw new Error('No card details found in payment details');
        }

        // Create payment method from card details
        const paymentMethod = await stripe.paymentMethods.create({
            type: 'card',
            card: {
                number: cardDetails.cardNumber,
                exp_month: parseInt(cardDetails.expiryMonth),
                exp_year: parseInt(cardDetails.expiryYear),
                cvc: cardDetails.cardSecurityCode
            },
            billing_details: {
                name: cardDetails.cardholderName || 'Anonymous'
            }
        });

        // Create and confirm payment intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: paymentData.amount,
            currency: paymentData.currency.toLowerCase(),
            description: paymentData.description,
            payment_method: paymentMethod.id,
            confirmation_method: 'manual',
            confirm: true,
            metadata: {
                type: 'basic_card_gift',
                paymentId: paymentData.paymentId
            }
        });

        if (paymentIntent.status === 'succeeded') {
            return {
                success: true,
                paymentId: paymentData.paymentId,
                transactionId: paymentIntent.id
            };
        } else {
            throw new Error(`Payment failed with status: ${paymentIntent.status}`);
        }
    } catch (error) {
        console.error('[Basic Card] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Card payment processing
async function processCardPayment(paymentData) {
    try {
        console.log('[Card Payment] Processing payment:', paymentData.paymentId);
        
        if (!stripe) {
            throw new Error('Stripe not configured for card processing');
        }

        // Extract card details from payment details
        const cardDetails = paymentData.paymentDetails?.details;
        
        if (!cardDetails) {
            throw new Error('No card details found in payment details');
        }

        // For basic card payments, we might get different token formats
        let paymentMethodId;
        
        if (cardDetails.paymentMethod) {
            // If we have a payment method ID directly
            paymentMethodId = cardDetails.paymentMethod;
        } else if (cardDetails.token) {
            // Create payment method from token
            const paymentMethod = await stripe.paymentMethods.create({
                type: 'card',
                card: {
                    token: cardDetails.token
                }
            });
            paymentMethodId = paymentMethod.id;
        } else {
            throw new Error('No valid payment method or token found');
        }

        // Create and confirm payment intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: paymentData.amount,
            currency: paymentData.currency.toLowerCase(),
            description: paymentData.description,
            payment_method: paymentMethodId,
            confirmation_method: 'manual',
            confirm: true,
            metadata: {
                type: 'card_gift',
                paymentId: paymentData.paymentId
            }
        });

        if (paymentIntent.status === 'succeeded') {
            return {
                success: true,
                paymentId: paymentData.paymentId,
                transactionId: paymentIntent.id
            };
        } else {
            throw new Error(`Payment failed with status: ${paymentIntent.status}`);
        }
    } catch (error) {
        console.error('[Card Payment] Error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Process successful gift payment
async function processGiftPaymentSuccess(paymentData) {
    try {
        console.log('[Gift Payment Success] Processing:', paymentData);

        // Calculate platform fee (10% of gift cost)
        const platformFeeAmount = paymentData.amount * 0.10; // 10% platform fee
        const hostEarningAmount = paymentData.amount * 0.80; // 80% to host (remaining 10% covers processing fees)

        // Add gift to Firestore
        const giftRef = db.collection('sideRooms').doc(paymentData.roomId).collection('gifts').doc();
        await giftRef.set({
            giftId: paymentData.giftId,
            giftType: 'premium', // All paid gifts are premium
            giftName: getGiftNameById(paymentData.giftId),
            senderId: paymentData.senderId,
            senderName: paymentData.senderName || await getUserDisplayName(paymentData.senderId),
            receiverId: paymentData.receiverId,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            value: paymentData.amount,
            cost: paymentData.amount,
            currency: paymentData.currency || 'GBP',
            paymentId: paymentData.paymentId,
            transactionId: paymentData.transactionId,
            stripePaymentIntentId: paymentData.stripePaymentIntentId || null,
            status: 'completed',
            platformFee: platformFeeAmount,
            hostEarning: hostEarningAmount,
            isDemo: paymentData.isDemo || false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Calculate host earnings in SideCoins (80% of gift cost)
        const hostEarningInSC = hostEarningAmount / 0.005; // Convert to SideCoins
        
        // Update host's balance
        const hostRef = db.collection('users').doc(paymentData.receiverId);
        await hostRef.update({
            sideCoins: admin.firestore.FieldValue.increment(hostEarningInSC),
            giftCount: admin.firestore.FieldValue.increment(1),
            giftValue: admin.firestore.FieldValue.increment(paymentData.amount),
            lastGiftReceived: admin.firestore.FieldValue.serverTimestamp()
        });

        // Record platform fee for accounting (only for real payments)
        if (!paymentData.isDemo) {
            await recordPlatformFee({
                amount: platformFeeAmount,
                currency: paymentData.currency || 'GBP',
                giftId: paymentData.giftId,
                paymentId: paymentData.paymentId,
                transactionId: paymentData.transactionId,
                stripePaymentIntentId: paymentData.stripePaymentIntentId,
                senderId: paymentData.senderId,
                receiverId: paymentData.receiverId,
                roomId: paymentData.roomId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            // Transfer platform fee to business account (try Stripe first, fallback to manual)
            await processPlatformFeeTransfer({
                amount: platformFeeAmount,
                currency: paymentData.currency || 'GBP',
                paymentId: paymentData.paymentId,
                transactionId: paymentData.transactionId,
                giftId: paymentData.giftId,
                description: `Platform fee for gift ${paymentData.giftId} - ${paymentData.paymentId}`
            });
        } else {
            console.log('[Gift Payment Success] Demo mode - skipping platform fee processing');
        }

        // Send receipt email if email is available (only for real payments)
        if (paymentData.customerEmail && !paymentData.isDemo) {
            await sendGiftReceipt({
                email: paymentData.customerEmail,
                giftName: getGiftNameById(paymentData.giftId),
                amount: paymentData.amount,
                currency: paymentData.currency || 'GBP',
                paymentId: paymentData.paymentId,
                transactionId: paymentData.transactionId,
                hostName: await getUserDisplayName(paymentData.receiverId),
                roomId: paymentData.roomId,
                isDemo: false
            });
        } else if (paymentData.isDemo) {
            console.log('[Gift Payment Success] Demo mode - skipping email receipt');
        }

        console.log('[Gift Payment Success] Processed successfully', {
            paymentId: paymentData.paymentId,
            hostEarningInSC: hostEarningInSC.toFixed(2),
            platformFee: platformFeeAmount.toFixed(2),
            isDemo: paymentData.isDemo || false
        });
    } catch (error) {
        console.error('[Gift Payment Success] Error:', error);
        throw error; // Re-throw to handle in calling function
    }
}

// Helper function to get gift name by ID
function getGiftNameById(giftId) {
    const giftNames = {
        'heart-gift': 'Heart',
        'side-eye-gift': 'Side Eye',
        'confetti-gift': 'Confetti',
        'crown-gift': 'Crown'
    };
    return giftNames[giftId] || 'Unknown Gift';
}

// Helper function to get user display name
async function getUserDisplayName(userId) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists()) {
            const userData = userDoc.data();
            return userData.name || userData.username || 'Unknown User';
        }
        return 'Unknown User';
    } catch (error) {
        console.error('[Get User Display Name] Error:', error);
        return 'Unknown User';
    }
}

// Send gift receipt email
async function sendGiftReceipt(receiptData) {
    try {
        console.log('[Gift Receipt] Sending receipt to:', receiptData.email);
        
        // Check if Mailgun is configured
        if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
            console.warn('[Gift Receipt] Mailgun not configured - skipping email send');
            return;
        }

        const mailgunApiKey = process.env.MAILGUN_API_KEY;
        const mailgunDomain = process.env.MAILGUN_DOMAIN;
        
        // Generate receipt HTML
        const receiptHTML = generateReceiptHTML(receiptData);
        
        // Prepare Mailgun API request
        const formData = new URLSearchParams();
        formData.append('from', `SideEye <noreply@${mailgunDomain}>`);
        formData.append('to', receiptData.email);
        formData.append('subject', `🎁 Gift Receipt - ${receiptData.giftName} | SideEye`);
        formData.append('html', receiptHTML);
        formData.append('text', generateReceiptText(receiptData));

        // Send email via Mailgun API
        const response = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData
        });

        if (response.ok) {
            const result = await response.json();
            console.log('[Gift Receipt] Email sent successfully:', result.id);
        } else {
            const error = await response.text();
            console.error('[Gift Receipt] Mailgun API error:', error);
        }
        
    } catch (error) {
        console.error('[Gift Receipt] Error sending receipt:', error);
    }
}

// Generate HTML receipt template
function generateReceiptHTML(receiptData) {
    const currentDate = new Date().toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SideEye Gift Receipt</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
            .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
            .header p { margin: 10px 0 0 0; opacity: 0.9; font-size: 16px; }
            .content { padding: 30px; }
            .receipt-details { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; }
            .detail-row { display: flex; justify-content: space-between; margin: 10px 0; padding: 8px 0; border-bottom: 1px solid #e9ecef; }
            .detail-row:last-child { border-bottom: none; font-weight: 600; font-size: 18px; color: #28a745; }
            .gift-icon { font-size: 48px; text-align: center; margin: 20px 0; }
            .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
            .button { display: inline-block; background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎁 Gift Receipt</h1>
                <p>Thank you for your purchase!</p>
            </div>
            
            <div class="content">
                <div class="gift-icon">
                    ${getGiftEmoji(receiptData.giftName)}
                </div>
                
                <h2 style="text-align: center; color: #333; margin: 0 0 20px 0;">
                    ${receiptData.giftName} Gift Sent Successfully!
                </h2>
                
                <p style="text-align: center; color: #666; font-size: 16px;">
                    Your gift has been sent to <strong>${receiptData.hostName}</strong> and they've been notified.
                </p>
                
                <div class="receipt-details">
                    <div class="detail-row">
                        <span>Gift Type:</span>
                        <span><strong>${receiptData.giftName}</strong></span>
                    </div>
                    <div class="detail-row">
                        <span>Recipient:</span>
                        <span>${receiptData.hostName}</span>
                    </div>
                    <div class="detail-row">
                        <span>Date & Time:</span>
                        <span>${currentDate}</span>
                    </div>
                    <div class="detail-row">
                        <span>Payment ID:</span>
                        <span style="font-family: monospace; font-size: 12px;">${receiptData.paymentId}</span>
                    </div>
                    <div class="detail-row">
                        <span>Total Amount:</span>
                        <span>${receiptData.currency} ${receiptData.amount.toFixed(2)}</span>
                    </div>
                </div>
                
                <div style="background: #e8f5e8; border-radius: 8px; padding: 15px; margin: 20px 0; text-align: center;">
                    <p style="margin: 0; color: #28a745; font-weight: 600;">
                        💰 The host earned ${((receiptData.amount * 0.8) / 0.005).toFixed(0)} SideCoins from your gift!
                    </p>
                    <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">
                        (80% of gift value converted to withdrawable SideCoins)
                    </p>
                </div>
                
                <div style="text-align: center;">
                    <a href="https://sideeye.uk" class="button">Return to SideEye</a>
                </div>
            </div>
            
            <div class="footer">
                <p><strong>SideEye</strong> - Connecting Communities</p>
                <p>This is an automated receipt. Please keep this for your records.</p>
                <p>Need help? Contact us at <a href="mailto:support@sideeye.uk">support@sideeye.uk</a></p>
            </div>
        </div>
    </body>
    </html>
    `;
}

// Generate plain text receipt
function generateReceiptText(receiptData) {
    const currentDate = new Date().toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    return `
🎁 SIDEEYE GIFT RECEIPT

Thank you for your purchase!

Gift Details:
- Gift Type: ${receiptData.giftName}
- Recipient: ${receiptData.hostName}
- Date & Time: ${currentDate}
- Payment ID: ${receiptData.paymentId}
- Total Amount: ${receiptData.currency} ${receiptData.amount.toFixed(2)}

💰 The host earned ${((receiptData.amount * 0.8) / 0.005).toFixed(0)} SideCoins from your gift!
(80% of gift value converted to withdrawable SideCoins)

Visit SideEye: https://sideeye.uk
Need help? Contact: support@sideeye.uk

This is an automated receipt. Please keep this for your records.
    `;
}

// Get emoji for gift type
function getGiftEmoji(giftName) {
    const emojis = {
        'Heart': '❤️',
        'Side Eye': '👀',
        'Confetti': '🎉',
        'Crown': '👑'
    };
    return emojis[giftName] || '🎁';
}

// Record platform fee for accounting and analytics
async function recordPlatformFee(feeData) {
    try {
        console.log('[Platform Fee] Recording fee:', feeData.amount, feeData.currency);
        
        // Store in Firestore for accounting
        await db.collection('platformFees').add({
            amount: feeData.amount,
            currency: feeData.currency,
            giftId: feeData.giftId,
            paymentId: feeData.paymentId,
            senderId: feeData.senderId,
            receiverId: feeData.receiverId,
            roomId: feeData.roomId,
            timestamp: feeData.timestamp,
            status: 'recorded',
            transferStatus: 'pending'
        });
        
        console.log('[Platform Fee] Fee recorded successfully');
    } catch (error) {
        console.error('[Platform Fee] Error recording fee:', error);
    }
}

// Transfer platform fee to business account using Stripe
async function transferPlatformFeeToBusinessAccount(transferData) {
    try {
        if (!stripe) {
            console.warn('[Platform Fee Transfer] Stripe not configured - skipping transfer');
            return;
        }

        console.log('[Platform Fee Transfer] Transferring to business account:', transferData.amount, transferData.currency);
        
        // Convert amount to cents for Stripe
        const amountInCents = Math.round(transferData.amount * 100);
        
        // Create transfer to your business account
        const transfer = await stripe.transfers.create({
            amount: amountInCents,
            currency: transferData.currency.toLowerCase(),
            destination: process.env.STRIPE_BUSINESS_ACCOUNT_ID, // Your Stripe Connect account ID
            description: transferData.description,
            metadata: {
                type: 'platform_fee',
                paymentId: transferData.paymentId,
                originalAmount: transferData.amount.toString()
            }
        });

        console.log('[Platform Fee Transfer] Transfer successful:', transfer.id);
        
        // Update the platform fee record with transfer info
        const feeQuery = db.collection('platformFees').where('paymentId', '==', transferData.paymentId);
        const feeSnapshot = await feeQuery.get();
        
        if (!feeSnapshot.empty) {
            const feeDoc = feeSnapshot.docs[0];
            await feeDoc.ref.update({
                transferStatus: 'completed',
                transferId: transfer.id,
                transferDate: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        return transfer;
    } catch (error) {
        console.error('[Platform Fee Transfer] Error transferring fee:', error);
        
        // Update the platform fee record with error status
        try {
            const feeQuery = db.collection('platformFees').where('paymentId', '==', transferData.paymentId);
            const feeSnapshot = await feeQuery.get();
            
            if (!feeSnapshot.empty) {
                const feeDoc = feeSnapshot.docs[0];
                await feeDoc.ref.update({
                    transferStatus: 'failed',
                    transferError: error.message,
                    transferDate: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        } catch (updateError) {
            console.error('[Platform Fee Transfer] Error updating fee record:', updateError);
        }
    }
}

// Alternative: Manual bank transfer function (for non-Stripe solutions)
async function scheduleBankTransfer(transferData) {
    try {
        console.log('[Bank Transfer] Scheduling manual transfer:', transferData.amount, transferData.currency);
        
        // Store transfer request for manual processing
        const transferDoc = await db.collection('pendingBankTransfers').add({
            amount: transferData.amount,
            currency: transferData.currency,
            type: 'platform_fee',
            paymentId: transferData.paymentId,
            giftId: transferData.giftId || null,
            description: transferData.description,
            status: 'pending_manual_processing',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            businessBankAccount: {
                accountName: process.env.BUSINESS_BANK_ACCOUNT_NAME || 'SideEye Ltd',
                accountNumber: process.env.BUSINESS_BANK_ACCOUNT_NUMBER,
                sortCode: process.env.BUSINESS_BANK_SORT_CODE,
                bankName: process.env.BUSINESS_BANK_NAME
            },
            priority: 'normal', // Can be 'high', 'normal', 'low'
            transferMethod: 'manual_bank_transfer'
        });
        
        // Update the platform fee record to show it's scheduled for manual transfer
        await updatePlatformFeeRecord(transferData.paymentId, {
            transferStatus: 'scheduled_manual',
            manualTransferId: transferDoc.id,
            transferDate: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Send notification to admin about pending transfer
        if (process.env.ADMIN_EMAIL) {
            await sendAdminNotification({
                type: 'pending_bank_transfer',
                amount: transferData.amount,
                currency: transferData.currency,
                paymentId: transferData.paymentId,
                transferId: transferDoc.id
            });
        }
        
        console.log('[Bank Transfer] Transfer scheduled for manual processing with ID:', transferDoc.id);
        return transferDoc.id;
    } catch (error) {
        console.error('[Bank Transfer] Error scheduling transfer:', error);
        throw error; // Re-throw so the calling function knows it failed
    }
}

// Send admin notification for manual transfers
async function sendAdminNotification(notificationData) {
    try {
        if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN || !process.env.ADMIN_EMAIL) {
            console.warn('[Admin Notification] Email not configured - skipping notification');
            return;
        }

        const mailgunApiKey = process.env.MAILGUN_API_KEY;
        const mailgunDomain = process.env.MAILGUN_DOMAIN;
        
        const reasonText = notificationData.reason ? 
            `<p><strong>Reason:</strong> ${notificationData.reason}</p>` : '';
        
        const formData = new URLSearchParams();
        formData.append('from', `SideEye Admin <admin@${mailgunDomain}>`);
        formData.append('to', process.env.ADMIN_EMAIL);
        formData.append('subject', `💰 Platform Fee Transfer Required - ${notificationData.currency} ${notificationData.amount.toFixed(2)}`);
        formData.append('html', `
            <h2>Platform Fee Transfer Required</h2>
            <p><strong>Amount:</strong> ${notificationData.currency} ${notificationData.amount.toFixed(2)}</p>
            <p><strong>Payment ID:</strong> ${notificationData.paymentId}</p>
            <p><strong>Type:</strong> ${notificationData.type}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
            ${reasonText}
            
            <p>Please process this transfer to your business bank account.</p>
            
            <hr>
            <h3>Business Bank Details:</h3>
            <p><strong>Account Name:</strong> ${process.env.BUSINESS_BANK_ACCOUNT_NAME || 'SideEye Ltd'}</p>
            <p><strong>Account Number:</strong> ${process.env.BUSINESS_BANK_ACCOUNT_NUMBER || 'Not configured'}</p>
            <p><strong>Sort Code:</strong> ${process.env.BUSINESS_BANK_SORT_CODE || 'Not configured'}</p>
            <p><strong>Bank Name:</strong> ${process.env.BUSINESS_BANK_NAME || 'Not configured'}</p>
        `);

        const response = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData
        });

        if (response.ok) {
            console.log('[Admin Notification] Email sent successfully');
        } else {
            console.error('[Admin Notification] Failed to send email');
        }
    } catch (error) {
        console.error('[Admin Notification] Error sending notification:', error);
    }
}

// Main platform fee transfer processor (tries Stripe first, falls back to manual)
async function processPlatformFeeTransfer(transferData) {
    try {
        console.log('[Platform Fee Transfer] Processing transfer:', transferData.amount, transferData.currency);
        
        // Method 1: Try Stripe Connect first (if configured)
        if (process.env.STRIPE_BUSINESS_ACCOUNT_ID && stripe) {
            console.log('[Platform Fee Transfer] Attempting Stripe Connect transfer...');
            
            try {
                const stripeResult = await transferPlatformFeeToBusinessAccount(transferData);
                if (stripeResult) {
                    console.log('[Platform Fee Transfer] Stripe transfer successful:', stripeResult.id);
                    return { method: 'stripe', success: true, transferId: stripeResult.id };
                }
            } catch (stripeError) {
                console.warn('[Platform Fee Transfer] Stripe transfer failed, falling back to manual:', stripeError.message);
                
                // Update platform fee record with Stripe failure info
                await updatePlatformFeeRecord(transferData.paymentId, {
                    stripeAttempted: true,
                    stripeError: stripeError.message,
                    stripeAttemptDate: admin.firestore.FieldValue.serverTimestamp()
                });
                
                // Send notification about Stripe failure
                if (process.env.ADMIN_EMAIL) {
                    await sendAdminNotification({
                        type: 'stripe_transfer_failed',
                        amount: transferData.amount,
                        currency: transferData.currency,
                        paymentId: transferData.paymentId,
                        reason: `Stripe transfer failed: ${stripeError.message}. Falling back to manual transfer.`
                    });
                }
            }
        } else {
            console.log('[Platform Fee Transfer] Stripe Connect not configured, using manual transfer');
        }
        
        // Method 2: Fallback to manual bank transfer
        console.log('[Platform Fee Transfer] Processing manual bank transfer...');
        await scheduleBankTransfer(transferData);
        
        return { method: 'manual', success: true, message: 'Scheduled for manual processing' };
        
    } catch (error) {
        console.error('[Platform Fee Transfer] All transfer methods failed:', error);
        
        // Update platform fee record with complete failure
        await updatePlatformFeeRecord(transferData.paymentId, {
            transferStatus: 'failed',
            transferError: error.message,
            transferDate: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Send critical failure notification
        if (process.env.ADMIN_EMAIL) {
            await sendAdminNotification({
                type: 'transfer_complete_failure',
                amount: transferData.amount,
                currency: transferData.currency,
                paymentId: transferData.paymentId,
                reason: `CRITICAL: All transfer methods failed. Error: ${error.message}`
            });
        }
        
        return { method: 'none', success: false, error: error.message };
    }
}

// Helper function to update platform fee records
async function updatePlatformFeeRecord(paymentId, updateData) {
    try {
        const feeQuery = db.collection('platformFees').where('paymentId', '==', paymentId);
        const feeSnapshot = await feeQuery.get();
        
        if (!feeSnapshot.empty) {
            const feeDoc = feeSnapshot.docs[0];
            await feeDoc.ref.update(updateData);
            console.log('[Platform Fee Record] Updated successfully');
        } else {
            console.warn('[Platform Fee Record] No record found for paymentId:', paymentId);
        }
    } catch (error) {
        console.error('[Platform Fee Record] Error updating record:', error);
    }
}

// Admin authentication middleware
async function authenticateAdmin(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No authorization token provided' });
        }
        
        const token = authHeader.split(' ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        
        if (decodedToken.email !== 'contact@sideeye.uk' && decodedToken.email !== 'enochaseks@yahoo.co.uk') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        
        req.adminUser = decodedToken;
        next();
    } catch (authError) {
        console.error('[Admin Auth] Error:', authError);
        return res.status(401).json({ error: 'Invalid authorization token' });
    }
}

// Payment success page endpoint
app.get('/api/payment-success/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        if (!stripe) {
            return res.status(500).json({ error: 'Payment service not configured' });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        
        res.json({
            success: true,
            paymentId: session.id,
            amount: session.amount_total / 100,
            currency: session.currency.toUpperCase(),
            status: session.payment_status
        });
    } catch (error) {
        console.error('[Payment Success] Error:', error);
        res.status(400).json({ error: 'Invalid session ID' });
    }
});

// Platform fee analytics endpoint (admin only)
app.get('/api/admin/platform-fees', authenticateAdmin, async (req, res) => {
    try {
        const { startDate, endDate, limit = 100 } = req.query;
        
        let query = db.collection('platformFees').orderBy('timestamp', 'desc');
        
        if (startDate) {
            query = query.where('timestamp', '>=', new Date(startDate));
        }
        if (endDate) {
            query = query.where('timestamp', '<=', new Date(endDate));
        }
        
        query = query.limit(parseInt(limit));
        
        const snapshot = await query.get();
        const fees = [];
        let totalFees = 0;
        let totalTransferred = 0;
        let pendingTransfers = 0;
        
        snapshot.forEach(doc => {
            const data = doc.data();
            fees.push({
                id: doc.id,
                ...data,
                timestamp: data.timestamp?.toDate?.() || data.timestamp
            });
            
            totalFees += data.amount || 0;
            
            if (data.transferStatus === 'completed') {
                totalTransferred += data.amount || 0;
            } else if (data.transferStatus === 'pending') {
                pendingTransfers += data.amount || 0;
            }
        });
        
        res.json({
            fees,
            analytics: {
                totalFees: totalFees.toFixed(2),
                totalTransferred: totalTransferred.toFixed(2),
                pendingTransfers: pendingTransfers.toFixed(2),
                transferRate: totalFees > 0 ? ((totalTransferred / totalFees) * 100).toFixed(1) : 0
            }
        });
        
    } catch (error) {
        console.error('[Admin Platform Fees] Error:', error);
        res.status(500).json({ error: 'Failed to fetch platform fees' });
    }
});

// Manual transfer trigger endpoint (admin only)
app.post('/api/admin/trigger-transfer', async (req, res) => {
    try {
        // TODO: Add admin authentication here
        const { feeId } = req.body;
        
        if (!feeId) {
            return res.status(400).json({ error: 'Fee ID required' });
        }
        
        const feeDoc = await db.collection('platformFees').doc(feeId).get();
        
        if (!feeDoc.exists) {
            return res.status(404).json({ error: 'Platform fee not found' });
        }
        
        const feeData = feeDoc.data();
        
        if (feeData.transferStatus === 'completed') {
            return res.status(400).json({ error: 'Transfer already completed' });
        }
        
        // Attempt transfer
        const transferResult = await transferPlatformFeeToBusinessAccount({
            amount: feeData.amount,
            currency: feeData.currency,
            paymentId: feeData.paymentId,
            description: `Manual transfer for platform fee - ${feeData.paymentId}`
        });
        
        if (transferResult) {
            res.json({ 
                success: true, 
                transferId: transferResult.id,
                message: 'Transfer completed successfully'
            });
        } else {
            res.status(500).json({ error: 'Transfer failed' });
        }
        
    } catch (error) {
        console.error('[Admin Transfer Trigger] Error:', error);
        res.status(500).json({ error: 'Failed to trigger transfer' });
    }
});

// Get pending manual transfers (admin only)
app.get('/api/admin/pending-transfers', async (req, res) => {
    try {
        // TODO: Add admin authentication here
        const { status = 'pending_manual_processing', limit = 50 } = req.query;
        
        let query = db.collection('pendingBankTransfers')
            .where('status', '==', status)
            .orderBy('createdAt', 'desc')
            .limit(parseInt(limit));
        
        const snapshot = await query.get();
        const transfers = [];
        let totalAmount = 0;
        
        snapshot.forEach(doc => {
            const data = doc.data();
            transfers.push({
                id: doc.id,
                ...data,
                createdAt: data.createdAt?.toDate?.() || data.createdAt
            });
            totalAmount += data.amount || 0;
        });
        
        res.json({
            transfers,
            summary: {
                count: transfers.length,
                totalAmount: totalAmount.toFixed(2),
                currency: transfers.length > 0 ? transfers[0].currency : 'GBP'
            }
        });
        
    } catch (error) {
        console.error('[Admin Pending Transfers] Error:', error);
        res.status(500).json({ error: 'Failed to fetch pending transfers' });
    }
});

// Mark manual transfer as completed (admin only)
app.post('/api/admin/complete-manual-transfer', async (req, res) => {
    try {
        // TODO: Add admin authentication here
        const { transferId, bankTransactionId, notes } = req.body;
        
        if (!transferId) {
            return res.status(400).json({ error: 'Transfer ID required' });
        }
        
        // Update the pending transfer record
        const transferRef = db.collection('pendingBankTransfers').doc(transferId);
        const transferDoc = await transferRef.get();
        
        if (!transferDoc.exists) {
            return res.status(404).json({ error: 'Transfer not found' });
        }
        
        const transferData = transferDoc.data();
        
        await transferRef.update({
            status: 'completed',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            bankTransactionId: bankTransactionId || null,
            completionNotes: notes || null,
            completedBy: 'admin' // In production, use actual admin user ID
        });
        
        // Update the corresponding platform fee record
        if (transferData.paymentId) {
            await updatePlatformFeeRecord(transferData.paymentId, {
                transferStatus: 'completed',
                manualTransferCompleted: true,
                bankTransactionId: bankTransactionId || null,
                transferCompletedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        
        res.json({
            success: true,
            message: 'Manual transfer marked as completed',
            transferId: transferId,
            amount: transferData.amount,
            currency: transferData.currency
        });
        
    } catch (error) {
        console.error('[Admin Complete Transfer] Error:', error);
        res.status(500).json({ error: 'Failed to complete transfer' });
    }
});

// Admin endpoint to view withdrawal requests
app.get('/api/admin/withdrawal-requests', authenticateAdmin, async (req, res) => {
    try {
        const { status, limit = 50, userId } = req.query;
        
        let query = db.collection('withdrawalRequests').orderBy('requestDate', 'desc');
        
        if (status) {
            query = query.where('status', '==', status);
        }
        
        if (userId) {
            query = query.where('userId', '==', userId);
        }
        
        if (limit) {
            query = query.limit(parseInt(limit));
        }
        
        const snapshot = await query.get();
        const withdrawals = [];
        
        for (const doc of snapshot.docs) {
            const data = doc.data();
            
            // Get bank details if bankDetailsId exists
            let bankDetails = null;
            if (data.bankDetailsId && data.userId) {
                try {
                    const bankDetailsDoc = await db.collection('users')
                        .doc(data.userId)
                        .collection('bankDetails')
                        .doc(data.bankDetailsId)
                        .get();
                    
                    if (bankDetailsDoc.exists()) {
                        const bankData = bankDetailsDoc.data();
                        bankDetails = {
                            accountName: bankData.accountName,
                            bankName: bankData.bankName,
                            sortCode: bankData.sortCode,
                            // For admin view, show full account number (encrypted in storage)
                            accountNumber: bankData.accountNumber
                        };
                    }
                } catch (error) {
                    console.error('[Admin] Error fetching bank details:', error);
                }
            }
            
            withdrawals.push({
                id: doc.id,
                ...data,
                bankDetails,
                requestDate: data.requestDate?.toDate(),
                processedDate: data.processedDate?.toDate()
            });
        }
        
        res.json({
            success: true,
            withdrawals,
            total: withdrawals.length
        });
        
    } catch (error) {
        console.error('[Admin] Error fetching withdrawal requests:', error);
        res.status(500).json({ error: 'Failed to fetch withdrawal requests' });
    }
});

// Admin endpoint to approve/reject withdrawal requests
app.post('/api/admin/withdrawal-requests/:id/update-status', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, adminNotes, bankTransactionId } = req.body;
        
        if (!['approved', 'rejected', 'completed'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        const withdrawalRef = db.collection('withdrawalRequests').doc(id);
        const withdrawalDoc = await withdrawalRef.get();
        
        if (!withdrawalDoc.exists()) {
            return res.status(404).json({ error: 'Withdrawal request not found' });
        }
        
        const withdrawalData = withdrawalDoc.data();
        
        // Update withdrawal status
        const updateData = {
            status,
            processedDate: admin.firestore.FieldValue.serverTimestamp(),
            adminNotes: adminNotes || '',
            processedBy: 'admin' // In production, use actual admin user ID
        };
        
        if (bankTransactionId) {
            updateData.bankTransactionId = bankTransactionId;
        }
        
        await withdrawalRef.update(updateData);
        
        // If rejected, refund the user's balance
        if (status === 'rejected') {
            const userRef = db.collection('users').doc(withdrawalData.userId);
            const userDoc = await userRef.get();
            
            if (userDoc.exists()) {
                const userData = userDoc.data();
                const currentBalance = userData.sideCoins || 0;
                const pendingWithdrawal = userData.pendingWithdrawal || 0;
                
                await userRef.update({
                    sideCoins: currentBalance + withdrawalData.amount,
                    pendingWithdrawal: Math.max(0, pendingWithdrawal - withdrawalData.amount)
                });
                
                console.log(`[Admin] Refunded ${withdrawalData.amount} SC to user ${withdrawalData.userId}`);
            }
        }
        
        // If approved, send notification to process bank transfer
        if (status === 'approved') {
            try {
                const bankDetailsDoc = await db.collection('users')
                    .doc(withdrawalData.userId)
                    .collection('bankDetails')
                    .doc(withdrawalData.bankDetailsId)
                    .get();
                
                if (bankDetailsDoc.exists()) {
                    const bankData = bankDetailsDoc.data();
                    
                    // Send notification to admin for manual bank transfer
                    await sendAdminNotification({
                        type: 'withdrawal_approved',
                        amount: withdrawalData.moneyAmount,
                        currency: 'GBP',
                        withdrawalId: id,
                        userEmail: withdrawalData.userEmail,
                        userName: withdrawalData.userName,
                        bankDetails: {
                            accountName: bankData.accountName,
                            accountNumber: bankData.accountNumber,
                            sortCode: bankData.sortCode,
                            bankName: bankData.bankName
                        }
                    });
                }
            } catch (error) {
                console.error('[Admin] Error sending bank transfer notification:', error);
            }
        }
        
        res.json({
            success: true,
            message: `Withdrawal request ${status} successfully`
        });
        
    } catch (error) {
        console.error('[Admin] Error updating withdrawal status:', error);
        res.status(500).json({ error: 'Failed to update withdrawal status' });
    }
});

// Enhanced admin notification function for withdrawals
async function sendWithdrawalNotification(notificationData) {
    try {
        if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN || !process.env.ADMIN_EMAIL) {
            console.warn('[Withdrawal Notification] Email not configured - skipping notification');
            return;
        }

        const mailgunApiKey = process.env.MAILGUN_API_KEY;
        const mailgunDomain = process.env.MAILGUN_DOMAIN;
        
        let subject, htmlContent;
        
        if (notificationData.type === 'withdrawal_approved') {
            subject = `💰 Withdrawal Approved - £${notificationData.amount.toFixed(2)} to ${notificationData.userName}`;
            htmlContent = `
                <h2>Withdrawal Approved - Bank Transfer Required</h2>
                <p><strong>User:</strong> ${notificationData.userName} (${notificationData.userEmail})</p>
                <p><strong>Amount:</strong> £${notificationData.amount.toFixed(2)}</p>
                <p><strong>Withdrawal ID:</strong> ${notificationData.withdrawalId}</p>
                <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                
                <hr>
                <h3>Bank Transfer Details:</h3>
                <p><strong>Account Name:</strong> ${notificationData.bankDetails.accountName}</p>
                <p><strong>Account Number:</strong> ${notificationData.bankDetails.accountNumber}</p>
                <p><strong>Sort Code:</strong> ${notificationData.bankDetails.sortCode}</p>
                <p><strong>Bank Name:</strong> ${notificationData.bankDetails.bankName}</p>
                
                <p><strong>Reference:</strong> SIDEEYE-${notificationData.withdrawalId}</p>
                
                <p>Please process this bank transfer and mark as completed in the admin panel.</p>
            `;
        } else {
            subject = `🔔 Withdrawal Notification - ${notificationData.type}`;
            htmlContent = `
                <h2>Withdrawal Notification</h2>
                <p><strong>Type:</strong> ${notificationData.type}</p>
                <p><strong>Amount:</strong> £${notificationData.amount.toFixed(2)}</p>
                <p><strong>Details:</strong> ${JSON.stringify(notificationData, null, 2)}</p>
            `;
        }
        
        const formData = new URLSearchParams();
        formData.append('from', `SideEye Admin <admin@${mailgunDomain}>`);
        formData.append('to', process.env.ADMIN_EMAIL);
        formData.append('subject', subject);
        formData.append('html', htmlContent);

        const response = await fetch(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData
        });

        if (response.ok) {
            console.log('[Withdrawal Notification] Email sent successfully');
        } else {
            console.error('[Withdrawal Notification] Failed to send email');
        }
    } catch (error) {
        console.error('[Withdrawal Notification] Error sending notification:', error);
    }
}

// Add withdrawal processing endpoints after the existing payment endpoints

// Withdrawal request endpoint (this is called from the frontend)
app.post('/api/withdrawal-request', async (req, res) => {
    try {
        const {
            userId,
            amount, // in SC
            moneyAmount, // in GBP after fees
            platformFee,
            grossAmount,
            bankDetailsId,
            userEmail,
            userName
        } = req.body;

        console.log('[Withdrawal Request] Processing withdrawal request:', {
            userId,
            amount,
            moneyAmount,
            platformFee,
            userEmail
        });

        // Validate request
        if (!userId || !amount || !moneyAmount || !bankDetailsId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required withdrawal information' 
            });
        }

        // Validate minimum withdrawal amount (1000 SC = £5)
        if (amount < 1000) {
            return res.status(400).json({ 
                success: false, 
                error: 'Minimum withdrawal is 1000 SC (£5)' 
            });
        }

        // Check if user has already withdrawn this month
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        
        const existingWithdrawalsQuery = db.collection('withdrawalRequests')
            .where('userId', '==', userId)
            .where('withdrawalMonth', '==', currentMonth)
            .where('withdrawalYear', '==', currentYear)
            .where('status', 'in', ['pending', 'approved', 'completed']);
        
        const existingWithdrawals = await existingWithdrawalsQuery.get();
        
        if (!existingWithdrawals.empty) {
            return res.status(400).json({
                success: false,
                error: 'You can only withdraw once per month'
            });
        }

        // Create withdrawal request
        const withdrawalRequest = {
            userId,
            amount,
            moneyAmount,
            platformFee,
            grossAmount,
            status: 'pending',
            requestDate: admin.firestore.FieldValue.serverTimestamp(),
            bankDetailsId,
            userEmail,
            userName,
            withdrawalMonth: currentMonth,
            withdrawalYear: currentYear,
            processedBy: null,
            processedDate: null,
            transactionId: null
        };

        const docRef = await db.collection('withdrawalRequests').add(withdrawalRequest);
        
        console.log('[Withdrawal Request] Withdrawal request created:', docRef.id);

        // Send notification to admin
        await sendWithdrawalNotification({
            type: 'new_withdrawal_request',
            amount: moneyAmount,
            currency: 'GBP',
            withdrawalId: docRef.id,
            userEmail,
            userName
        });

        res.json({
            success: true,
            message: 'Withdrawal request submitted successfully',
            requestId: docRef.id
        });

    } catch (error) {
        console.error('[Withdrawal Request] Error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to process withdrawal request' 
        });
    }
});

// Log at the very end of the script
console.log('[SERVER END SCRIPT] server.js script fully parsed.');

// --- STATIC FILE SERVING (MUST BE LAST) ---
app.use(express.static(path.join(__dirname, '../frontend/build')));

// Catch-all handler for React app - ONLY for non-API routes
app.get('*', (req, res) => {
  // Don't serve React app for API routes - let them return 404 naturally
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'Not found',
      details: `API endpoint ${req.method} ${req.path} does not exist`
    });
  }
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});