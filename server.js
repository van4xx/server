const express = require('express');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const config = require('./config');

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
  }
});

// Хранилище для комнат и пользователей
const rooms = new Map();
const waitingUsers = new Map(); // Пользователи в поиске
const activeUsers = new Map();  // Активные пользователи

let worker;
let router;

// Инициализация MediaSoup
async function initializeMediasoup() {
  worker = await mediasoup.createWorker(config.mediasoup.worker);
  router = await worker.createRouter({ mediaCodecs: config.mediasoup.router.mediaCodecs });
  
  console.log('MediaSoup Worker and Router initialized');

  worker.on('died', () => {
    console.error('MediaSoup Worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });
}

// Создание WebRTC транспорта
async function createWebRtcTransport() {
  const transport = await router.createWebRtcTransport(config.mediasoup.webRtcTransport);
  
  transport.on('dtlsstatechange', (dtlsState) => {
    console.log('Transport dtls state changed to', dtlsState);
    if (dtlsState === 'closed') {
      transport.close();
    }
  });

  transport.on('close', () => {
    console.log('Transport closed');
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    }
  };
}

// Поиск партнера
function findPartner(socket, mode) {
  console.log('Finding partner for', socket.id, 'mode:', mode);
  
  // Проверяем, что пользователь не в поиске и не в активной комнате
  if (waitingUsers.has(socket.id) || activeUsers.has(socket.id)) {
    console.log('User already waiting or in room:', socket.id);
    return false;
  }

  // Получаем всех доступных пользователей
  const availablePartners = Array.from(waitingUsers.entries())
    .filter(([userId, userData]) => {
      return userId !== socket.id && // Не тот же самый пользователь
             userData.mode === mode && // Тот же режим
             !activeUsers.has(userId) && // Не в активной комнате
             socket.id !== userId; // Дополнительная проверка на самого себя
    });

  console.log('Available partners:', availablePartners.map(([id]) => id));

  if (availablePartners.length > 0) {
    // Выбираем случайного партнера из доступных
    const randomIndex = Math.floor(Math.random() * availablePartners.length);
    const [partnerId, partnerData] = availablePartners[randomIndex];

    console.log('Selected partner:', partnerId, 'for user:', socket.id, 'in mode:', mode);

    // Создаем комнату
    const roomId = `${socket.id}-${partnerId}`;
    const room = {
      id: roomId,
      users: [socket.id, partnerId],
      mode: mode,
      createdAt: Date.now()
    };
    rooms.set(roomId, room);

    // Удаляем пользователей из ожидающих
    waitingUsers.delete(partnerId);
    waitingUsers.delete(socket.id);

    // Добавляем обоих в активные
    activeUsers.set(socket.id, { roomId, partnerId, mode });
    activeUsers.set(partnerId, { roomId, partnerId: socket.id, mode });

    // Уведомляем обоих пользователей
    socket.join(roomId);
    io.sockets.sockets.get(partnerId)?.join(roomId);

    socket.emit('roomCreated', { roomId, partnerId, mode });
    io.to(partnerId).emit('roomCreated', { roomId, partnerId: socket.id, mode });

    console.log(`Room ${roomId} created for ${mode} chat`);
    return true;
  }

  // Если партнер не найден, добавляем в ожидающие
  console.log('No partner found, adding to waiting list:', socket.id, 'mode:', mode);
  waitingUsers.set(socket.id, { mode, joinedAt: Date.now() });
  socket.emit('waiting');
  return false;
}

io.on('connection', async (socket) => {
  console.log('Client connected:', socket.id);

  // Проверяем, нет ли уже такого пользователя
  if (activeUsers.has(socket.id)) {
    console.log('User already exists, disconnecting old session:', socket.id);
    const oldSocket = io.sockets.sockets.get(socket.id);
    if (oldSocket) {
      oldSocket.disconnect(true);
    }
    activeUsers.delete(socket.id);
  }

  // Обработка готовности к поиску
  socket.on('ready', async (mode) => {
    console.log('User ready:', socket.id, 'mode:', mode);
    
    try {
      // Проверяем, что пользователь не в комнате и не в поиске
      if (activeUsers.has(socket.id)) {
        console.log('User already in room:', socket.id);
        return;
      }

      if (waitingUsers.has(socket.id)) {
        console.log('User already waiting:', socket.id);
        return;
      }

      // Отправляем возможности маршрутизатора
      socket.emit('rtpCapabilities', router.rtpCapabilities);

      // Создаем транспорты
      const producerTransport = await createWebRtcTransport();
      const consumerTransport = await createWebRtcTransport();

      socket.producerTransport = producerTransport.transport;
      socket.consumerTransport = consumerTransport.transport;

      // Отправляем параметры транспортов
      socket.emit('transportCreated', {
        producerTransportOptions: producerTransport.params,
        consumerTransportOptions: consumerTransport.params
      });

      // Добавляем пользователя в список ожидающих
      waitingUsers.set(socket.id, { 
        mode, 
        joinedAt: Date.now(),
        socket: socket 
      });

      // Пытаемся найти партнера среди других ожидающих
      const availablePartners = Array.from(waitingUsers.entries())
        .filter(([userId, userData]) => 
          userId !== socket.id && 
          userData.mode === mode && 
          !activeUsers.has(userId)
        );

      console.log('Available partners:', availablePartners.map(([id]) => id));

      if (availablePartners.length > 0) {
        // Выбираем случайного партнера
        const randomIndex = Math.floor(Math.random() * availablePartners.length);
        const [partnerId, partnerData] = availablePartners[randomIndex];

        // Создаем комнату
        const roomId = `room-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const room = {
          id: roomId,
          users: [socket.id, partnerId],
          mode: mode,
          createdAt: Date.now()
        };

        console.log(`Creating room ${roomId} for users ${socket.id} and ${partnerId}`);

        // Удаляем обоих из ожидающих
        waitingUsers.delete(socket.id);
        waitingUsers.delete(partnerId);

        // Добавляем в активные
        activeUsers.set(socket.id, { roomId, partnerId, mode });
        activeUsers.set(partnerId, { roomId, partnerId: socket.id, mode });

        // Добавляем обоих в комнату
        socket.join(roomId);
        partnerData.socket.join(roomId);

        // Уведомляем обоих
        socket.emit('partnerFound', { partnerId, roomId });
        partnerData.socket.emit('partnerFound', { partnerId: socket.id, roomId });

        console.log(`Room ${roomId} created for ${mode} chat between ${socket.id} and ${partnerId}`);
      } else {
        console.log(`User ${socket.id} added to waiting list for ${mode} mode`);
        socket.emit('waiting');
      }

    } catch (error) {
      console.error('Error in ready handler:', error);
      socket.emit('error', { message: 'Failed to initialize connection' });
    }
  });

  // Подключение транспорта производителя
  socket.on('connectProducerTransport', async ({ dtlsParameters }, callback) => {
    try {
      await socket.producerTransport.connect({ dtlsParameters });
      callback();
    } catch (error) {
      console.error('connectProducerTransport error:', error);
      callback({ error: error.message });
    }
  });

  // Подключение транспорта потребителя
  socket.on('connectConsumerTransport', async ({ dtlsParameters }, callback) => {
    try {
      await socket.consumerTransport.connect({ dtlsParameters });
      callback();
    } catch (error) {
      console.error('connectConsumerTransport error:', error);
      callback({ error: error.message });
    }
  });

  // Создание производителя
  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    try {
      const producer = await socket.producerTransport.produce({ kind, rtpParameters });
      
      const userData = activeUsers.get(socket.id);
      if (userData) {
        const { partnerId } = userData;
        io.to(partnerId).emit('newProducer', { producerId: producer.id });
      }

      callback({ id: producer.id });
    } catch (error) {
      console.error('Produce error:', error);
      callback({ error: error.message });
    }
  });

  // Создание потребителя
  socket.on('consume', async ({ producerId }, callback) => {
    try {
      const consumer = await socket.consumerTransport.consume({
        producerId,
        rtpCapabilities: router.rtpCapabilities,
        paused: true
      });

      callback({
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerId: consumer.producerId
      });
    } catch (error) {
      console.error('Consume error:', error);
      callback({ error: error.message });
    }
  });

  // Отмена поиска
  socket.on('cancelSearch', () => {
    console.log('Search cancelled by:', socket.id);
    waitingUsers.delete(socket.id);
    socket.emit('searchCancelled');
  });

  // Обработка отключения
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Удаляем из ожидающих
    if (waitingUsers.has(socket.id)) {
      console.log(`Removing waiting user ${socket.id}`);
      waitingUsers.delete(socket.id);
    }
    
    // Если пользователь был в комнате
    const userData = activeUsers.get(socket.id);
    if (userData) {
      const { roomId, partnerId } = userData;
      console.log(`User ${socket.id} was in room ${roomId} with partner ${partnerId}`);
      
      // Уведомляем партнера
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('partnerLeft');
        partnerSocket.leave(roomId);
      }
      
      // Удаляем комнату
      rooms.delete(roomId);
      
      // Удаляем пользователей из активных
      activeUsers.delete(socket.id);
      activeUsers.delete(partnerId);

      socket.leave(roomId);
    }

    // Закрываем транспорты
    if (socket.producerTransport) {
      socket.producerTransport.close();
    }
    if (socket.consumerTransport) {
      socket.consumerTransport.close();
    }

    // Логируем состояние после отключения
    logServerState();
  });

  // Обработка ping/pong для мониторинга соединения
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Очистка неактивных пользователей каждые 30 секунд
setInterval(() => {
  const now = Date.now();
  
  // Очищаем зависших в поиске
  for (const [userId, userData] of waitingUsers) {
    if (now - userData.joinedAt > 30000) { // 30 секунд
      console.log('Removing stale waiting user:', userId);
      waitingUsers.delete(userId);
      io.to(userId).emit('searchCancelled');
    }
  }
  
  // Очищаем пустые комнаты
  for (const [roomId, room] of rooms) {
    if (room.users.every(userId => !io.sockets.sockets.has(userId))) {
      console.log('Removing empty room:', roomId);
      rooms.delete(roomId);
    }
  }
}, 30000);

// Добавим функцию для отладки состояния сервера
function logServerState() {
  console.log('\nServer State:');
  console.log('Waiting Users:', Array.from(waitingUsers.keys()));
  console.log('Active Users:', Array.from(activeUsers.keys()));
  console.log('Rooms:', Array.from(rooms.keys()));
  console.log('Connected Sockets:', Array.from(io.sockets.sockets.keys()));
  console.log('\n');
}

// Вызываем логирование каждые 5 секунд
setInterval(logServerState, 5000);

// Запуск сервера
const PORT = 5001;

(async () => {
  try {
    await initializeMediasoup();
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to initialize MediaSoup:', err);
    process.exit(1);
  }
})(); 