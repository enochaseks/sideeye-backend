import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ["http://localhost:3000", "https://www.sideeye.uk"],
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 1e7 // 10 MB for audio chunks
});

const PORT = process.env.PORT || 3001;

// Store active rooms and their participants
const rooms = new Map<string, Set<string>>();
const userSockets = new Map<string, string>(); // userId -> socketId

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle joining room
  socket.on('join-room', (roomId: string, userId: string) => {
    console.log(`User ${userId} joining room ${roomId}`);
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId)?.add(userId);
    userSockets.set(userId, socket.id);

    // Notify others in the room
    socket.to(roomId).emit('user-joined', userId);
    
    // Send current participants to the joining user
    const participants = Array.from(rooms.get(roomId) || []);
    socket.emit('room-users', participants);
    console.log(`Room ${roomId} participants:`, participants);
  });

  // Handle audio stream
  socket.on('audio-stream', (data: { roomId: string; userId: string; audio: ArrayBuffer }) => {
    // Broadcast audio to everyone else in the room
    console.log(`Received audio from ${data.userId} in ${data.roomId}, broadcasting...`);
    socket.to(data.roomId).emit('audio-stream', {
      audio: data.audio,
      userId: data.userId
    });
  });

  // Handle speaking status
  socket.on('user-speaking', (data: { roomId: string; userId: string; isSpeaking: boolean }) => {
    console.log(`User ${data.userId} speaking status in room ${data.roomId}:`, data.isSpeaking);
    socket.to(data.roomId).emit('user-speaking', {
      userId: data.userId,
      isSpeaking: data.isSpeaking
    });
  });

  // Handle mute status
  socket.on('user-muted', (data: { roomId: string; userId: string; isMuted: boolean }) => {
    console.log(`User ${data.userId} mute status in room ${data.roomId}:`, data.isMuted);
    socket.to(data.roomId).emit('user-muted', {
      userId: data.userId,
      isMuted: data.isMuted
    });
  });

  // Handle leaving room
  socket.on('leave-room', (roomId: string, userId: string) => {
    handleUserLeaveRoom(socket, roomId, userId);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Find and remove user from all rooms
    rooms.forEach((users, roomId) => {
      const userId = Array.from(users).find(id => userSockets.get(id) === socket.id);
      if (userId) {
        handleUserLeaveRoom(socket, roomId, userId);
      }
    });
  });
});

function handleUserLeaveRoom(socket: any, roomId: string, userId: string) {
  console.log(`User ${userId} leaving room ${roomId}`);
  socket.leave(roomId);
  const room = rooms.get(roomId);
  if (room) {
    room.delete(userId);
    if (room.size === 0) {
      rooms.delete(roomId);
    }
  }
  userSockets.delete(userId);
  socket.to(roomId).emit('user-left', userId);
}

// Start the server
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 