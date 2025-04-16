const express = require('express');
const cors = require('cors');
const Mux = require('@mux/mux-node');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { handleFileUpload } = require('./upload');

// Load environment variables first
dotenv.config();

// Then initialize Mux with the loaded environment variables
const { Video } = new Mux(process.env.MUX_TOKEN_ID, process.env.MUX_TOKEN_SECRET);

// Initialize Firebase Admin
const firebaseApp = admin.initializeApp({
  credential: admin.credential.cert(require('../serviceAccountKey.json')),
  databaseURL: process.env.REACT_APP_FIREBASE_DATABASE_URL,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/create-stream', async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required' });
    }

    console.log('Creating stream for room:', roomId);

    // Create stream in Mux
    const stream = await Video.LiveStreams.create({
      playback_policy: 'public',
      new_asset_settings: { playback_policy: 'public' }
    });

    console.log('Mux stream created:', stream);

    // Create the stream status document in Firestore
    const streamStatusRef = db.collection('sideRooms').doc(roomId).collection('streamStatus').doc('current');
    await streamStatusRef.set({
      streamId: stream.id,
      playbackId: stream.playback_ids[0].id,
      streamKey: stream.stream_key,
      isActive: false,
      createdAt: new Date().toISOString()
    });

    console.log('Stream status document created in Firestore');

    res.json({
      streamKey: stream.stream_key,
      playbackId: stream.playback_ids[0].id,
      streamId: stream.id
    });
  } catch (error) {
    console.error('Error creating live stream:', error);
    res.status(500).json({ 
      error: 'Failed to create live stream',
      details: error.message
    });
  }
});

app.get('/api/streams/:roomId/status', async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required' });
    }

    console.log('Checking stream status for room:', roomId);

    // Get stream status from Firestore
    const streamStatusRef = db.collection('sideRooms').doc(roomId).collection('streamStatus').doc('current');
    const streamStatusDoc = await streamStatusRef.get();
    
    if (!streamStatusDoc.exists) {
      console.log('No stream status document found for room:', roomId);
      return res.status(404).json({ error: 'Stream not found' });
    }

    const streamStatus = streamStatusDoc.data();
    console.log('Retrieved stream status:', streamStatus);
    
    // Check with Mux if the stream is active
    if (streamStatus?.streamId) {
      try {
        const stream = await Video.LiveStreams.get(streamStatus.streamId);
        console.log('Mux stream status:', stream.status);
        streamStatus.isActive = stream.status === 'active';
      } catch (muxError) {
        console.error('Error fetching Mux stream status:', muxError);
        // Don't fail the request if Mux check fails, just use the stored status
        streamStatus.isActive = streamStatus.isActive || false;
      }
    }

    res.json(streamStatus);
  } catch (error) {
    console.error('Error checking stream status:', error);
    res.status(500).json({ 
      error: 'Failed to check stream status',
      details: error.message
    });
  }
});

app.delete('/api/streams/:streamId', async (req, res) => {
  try {
    await Video.LiveStreams.delete(req.params.streamId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting live stream:', error);
    res.status(500).json({ error: 'Failed to delete live stream' });
  }
});

// Mux live streaming endpoints
app.post('/api/mux/create-stream', async (req, res) => {
  try {
    const { roomId, userId } = req.body;

    // Create a new live stream
    const stream = await Video.LiveStreams.create({
      playback_policy: 'public',
      new_asset_settings: { playback_policy: 'public' }
    });

    res.json({
      streamKey: stream.stream_key,
      playbackId: stream.playback_ids[0].id
    });
  } catch (error) {
    console.error('Error creating Mux stream:', error);
    res.status(500).json({ error: 'Failed to create stream' });
  }
});

app.post('/api/mux/delete-stream', async (req, res) => {
  try {
    const { roomId, userId } = req.body;

    // Get the stream ID from your database or room data
    // For now, we'll just return success
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting Mux stream:', error);
    res.status(500).json({ error: 'Failed to delete stream' });
  }
});

// Image upload endpoint
app.post('/api/upload-image', handleFileUpload('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { roomId, type } = req.body;
    if (!roomId || !type) {
      return res.status(400).json({ error: 'Room ID and type are required' });
    }

    const file = req.file;
    const fileName = `${roomId}/${type}/${Date.now()}-${file.originalname}`;
    const fileUpload = bucket.file(fileName);

    const stream = fileUpload.createWriteStream({
      metadata: {
        contentType: file.mimetype,
      },
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).json({ error: 'Error uploading file' });
    });

    stream.on('finish', async () => {
      try {
        // Make the file public
        await fileUpload.makePublic();
        
        // Get the public URL
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        
        // Update the room document with the new image URL
        const roomRef = db.collection('sideRooms').doc(roomId);
        await roomRef.update({
          [type === 'thumbnail' ? 'thumbnailUrl' : 'bannerUrl']: publicUrl
        });

        res.json({ url: publicUrl });
      } catch (err) {
        console.error('Error making file public:', err);
        res.status(500).json({ error: 'Error processing uploaded file' });
      }
    });

    stream.end(file.buffer);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Error uploading file' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 