const express = require('express');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// SSL конфигурация
const credentials = process.env.NODE_ENV === 'production' ? {
  key: fs.readFileSync('/etc/letsencrypt/live/ruletka.top/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/ruletka.top/fullchain.pem')
} : null;

const server = process.env.NODE_ENV === 'production' 
  ? https.createServer(credentials, app)
  : require('http').createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["https://ruletka.top", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  },
  path: '/socket.io/'
});

const users = {
  audio: new Map(),
  video: new Map()
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('ready', (mode) => {
    socket.mode = mode || 'video';
    users[socket.mode].set(socket.id, { socket });
    findPartner(socket);
  });

  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('next', () => {
    leaveCurrentPartner(socket);
    findPartner(socket);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    leaveCurrentPartner(socket);
    users.audio.delete(socket.id);
    users.video.delete(socket.id);
  });
});

function findPartner(socket) {
  const mode = socket.mode || 'video';
  const availableUsers = Array.from(users[mode].keys())
    .filter(id => id !== socket.id && !users[mode].get(id).partnerId);

  if (availableUsers.length > 0) {
    const partnerId = availableUsers[Math.floor(Math.random() * availableUsers.length)];
    const partner = users[mode].get(partnerId);

    // Связываем пользователей
    users[mode].get(socket.id).partnerId = partnerId;
    partner.partnerId = socket.id;

    // Уведомляем обоих пользователей
    socket.emit('partner-found', { partnerId });
    io.to(partnerId).emit('partner-found', { partnerId: socket.id });
  }
}

function leaveCurrentPartner(socket) {
  const mode = socket.mode || 'video';
  const user = users[mode].get(socket.id);
  
  if (user && user.partnerId) {
    const partner = users[mode].get(user.partnerId);
    if (partner) {
      delete partner.partnerId;
      io.to(user.partnerId).emit('partner-left');
    }
    delete user.partnerId;
  }
}

const PORT = 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 