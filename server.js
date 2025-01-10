const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["https://ruletka.top", "http://localhost:3000"],
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: false
  },

  path: '/socket.io/',
  transports: ['websocket'], 
  pingTimeout: 60000,
  pingInterval: 25000
});

// Добавим обработчик для проверки подключения
io.engine.on("connection_error", (err) => {
  console.log('Connection error:', err);
});

// Хранение пользователей в поиске
const searchingUsers = {
  audio: new Set(),
  video: new Set()
};

// Активные соединения
const connections = new Map();

// Функция для логирования состояния
const logState = () => {
  console.log('\nCurrent State:');
  console.log('Searching Users (Audio):', Array.from(searchingUsers.audio));
  console.log('Searching Users (Video):', Array.from(searchingUsers.video));
  console.log('Active Connections:', Array.from(connections.entries()));
  console.log('\n');
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  logState();

  // Обработка начала поиска
  socket.on('startSearch', () => {
    const userId = socket.id;
    const mode = socket.chatMode || 'video';
    console.log(`\nUser ${userId} started searching in ${mode} mode`);

    // Очищаем предыдущие состояния
    searchingUsers.audio.delete(userId);
    searchingUsers.video.delete(userId);
    
    // Если пользователь уже в соединении, разрываем его
    if (connections.has(userId)) {
      const oldConnection = connections.get(userId);
      socket.to(oldConnection.room).emit('partnerLeft');
      connections.delete(oldConnection.partner);
      connections.delete(userId);
      socket.leave(oldConnection.room);
    }

    // Добавляем в поиск
    searchingUsers[mode].add(userId);
    console.log(`Added user ${userId} to ${mode} search queue`);
    logState();

    // Ищем партнера
    for (const partnerId of searchingUsers[mode]) {
      if (partnerId !== userId && io.sockets.sockets.has(partnerId)) {
        const room = `room_${userId}_${partnerId}`;
        console.log(`\nTrying to create room ${room}`);

        // Удаляем обоих из поиска
        searchingUsers[mode].delete(userId);
        searchingUsers[mode].delete(partnerId);

        // Подключаем к комнате
        socket.join(room);
        const partnerSocket = io.sockets.sockets.get(partnerId);
        partnerSocket.join(room);

        // Сохраняем соединение
        connections.set(userId, { partner: partnerId, room });
        connections.set(partnerId, { partner: userId, room });

        console.log(`Room ${room} created successfully`);
        console.log(`Connected users: ${userId} and ${partnerId}`);

        // Уведомляем обоих пользователей
        io.to(room).emit('chatStart', { room });
        
        logState();
        break;
      }
    }
  });

  socket.on('setChatMode', (mode) => {
    console.log(`User ${socket.id} set mode to ${mode}`);
    socket.chatMode = mode;
  });

  socket.on('cancelSearch', () => {
    const mode = socket.chatMode || 'video';
    searchingUsers[mode].delete(socket.id);
    console.log(`User ${socket.id} cancelled search`);
    logState();
  });

  socket.on('message', (message) => {
    const connection = connections.get(socket.id);
    if (connection) {
      console.log(`Message from ${socket.id} in room ${connection.room}`);
      io.to(connection.room).emit('message', {
        ...message,
        sender: socket.id
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`\nUser disconnected: ${socket.id}`);
    
    // Очищаем все состояния пользователя
    searchingUsers.audio.delete(socket.id);
    searchingUsers.video.delete(socket.id);
    
    const connection = connections.get(socket.id);
    if (connection) {
      console.log(`Cleaning up connection in room ${connection.room}`);
      socket.to(connection.room).emit('partnerLeft');
      connections.delete(connection.partner);
      connections.delete(socket.id);
    }
    
    logState();
  });

  socket.on('signal', ({ signal, room }) => {
    console.log(`Signal from ${socket.id} in room ${room}`);
    const connection = connections.get(socket.id);
    if (connection) {
      socket.to(connection.room).emit('signal', { signal });
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
      const mode = socket.chatMode || 'video';
      searchingUsers[mode].add(socket.id);
      socket.emit('searchStart');
    }
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 