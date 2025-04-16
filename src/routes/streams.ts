import express, { Request, Response, Router } from 'express';
import Mux from '@mux/mux-node';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, getDoc, setDoc } from 'firebase/firestore';

const router: Router = express.Router();

// Initialize Firebase
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
  throw new Error('Mux credentials are not configured');
}

const mux = new Mux(process.env.MUX_TOKEN_ID, process.env.MUX_TOKEN_SECRET);

// Create a new stream
router.post('/create-stream', async (req: Request, res: Response) => {
  try {
    const { roomId } = req.body;
    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required' });
    }

    // Create a new live stream
    const stream = await mux.Video.LiveStreams.create({
      playback_policy: 'public',
      new_asset_settings: {
        playback_policy: 'public',
      },
    });

    // Store stream info in Firestore
    const streamStatusRef = doc(db, 'sideRooms', roomId, 'streamStatus', 'current');
    await setDoc(streamStatusRef, {
      streamId: stream.id,
      playbackId: stream.playback_ids?.[0]?.id,
      isActive: false,
      createdAt: new Date(),
    });

    res.json({
      streamKey: stream.stream_key,
      playbackId: stream.playback_ids?.[0]?.id,
    });
  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ error: 'Failed to create stream' });
  }
});

// Check stream status
router.get('/:roomId/status', async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required' });
    }

    // Get stream status from Firestore
    const streamStatusRef = doc(db, 'sideRooms', roomId, 'streamStatus', 'current');
    const streamStatusDoc = await getDoc(streamStatusRef);
    
    if (!streamStatusDoc.exists()) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    const streamStatus = streamStatusDoc.data();
    
    // Check with Mux if the stream is active
    if (streamStatus?.streamId) {
      const stream = await mux.Video.LiveStreams.get(streamStatus.streamId);
      streamStatus.isActive = stream.status === 'active';
    }

    res.json(streamStatus);
  } catch (error) {
    console.error('Error checking stream status:', error);
    res.status(500).json({ error: 'Failed to check stream status' });
  }
});

// Delete a stream
router.delete('/:streamId', async (req: Request, res: Response) => {
  try {
    const { streamId } = req.params;
    await mux.Video.LiveStreams.del(streamId);
    res.json({ message: 'Stream deleted successfully' });
  } catch (error) {
    console.error('Error deleting stream:', error);
    res.status(500).json({ error: 'Failed to delete stream' });
  }
});

export default router; 