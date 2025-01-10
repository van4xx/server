const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Настраиваем CORS для Express
app.use(cors({
  origin: ['https://ruletka.top', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
  credentials: true
}));

const server = http.createServer(app);

// Настраиваем Socket.IO с расширенными опциями CORS
const io = new Server(server, {
  cors: {
    origin: ['https://ruletka.top', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Добавляем базовый маршрут для проверки работы сервера
app.get('/', (req, res) => {
  res.send('WebSocket server is running');
});

// Хранение пользователей в поиске
const searchingUsers = {
  audio: new Set(),
  video: new Set()
};

// Активные соединения
const connections = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('startSearch', () => {
    const userId = socket.id;
    const mode = socket.chatMode || 'video';
    searchingUsers[mode].add(userId);
    
    // Поиск партнера
    for (const partnerId of searchingUsers[mode]) {
      if (partnerId !== userId) {
        const room = `room_${userId}_${partnerId}`;
        
        // Удаляем обоих из поиска
        searchingUsers[mode].delete(userId);
        searchingUsers[mode].delete(partnerId);
        
        // Подключаем обоих к комнате
        socket.join(room);
        io.sockets.sockets.get(partnerId)?.join(room);
        
        // Сохраняем информацию о соединении
        connections.set(userId, { partner: partnerId, room });
        connections.set(partnerId, { partner: userId, room });
        
        // Уведомляем обоих о соединении
        io.to(room).emit('chatStart', { room });
        break;
      }
    }
  });

  socket.on('setChatMode', (mode) => {
    socket.chatMode = mode;
  });

  socket.on('cancelSearch', () => {
    const mode = socket.chatMode || 'video';
    searchingUsers[mode].delete(socket.id);
  });

  socket.on('message', (message) => {
    const connection = connections.get(socket.id);
    if (connection) {
      io.to(connection.room).emit('message', {
        ...message,
        sender: socket.id
      });
    }
  });

  socket.on('handRaised', ({ roomId, raised }) => {
    const connection = connections.get(socket.id);
    if (connection) {
      socket.to(connection.room).emit('handRaised', { raised });
    }
  });

  socket.on('notification', ({ roomId }) => {
    const connection = connections.get(socket.id);
    if (connection) {
      socket.to(connection.room).emit('notification');
    }
  });

  socket.on('nextPartner', () => {
    const connection = connections.get(socket.id);
    if (connection) {
      // Уведомляем партнера
      socket.to(connection.room).emit('partnerLeft');
      
      // Очищаем старое соединение
      const partner = connection.partner;
      connections.delete(socket.id);
      connections.delete(partner);
      
      // Покидаем комнату
      socket.leave(connection.room);
      
      // Начинаем новый поиск
      socket.emit('searchStart');
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const mode = socket.chatMode || 'video';
    searchingUsers[mode].delete(socket.id);
    
    const connection = connections.get(socket.id);
    if (connection) {
      // Уведомляем партнера
      socket.to(connection.room).emit('partnerLeft');
      
      // Очищаем соединение
      connections.delete(connection.partner);
      connections.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 