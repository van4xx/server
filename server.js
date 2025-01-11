process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

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

// В начале файла добавим отладочный режим
const DEBUG = process.env.NODE_ENV !== 'production';
function debug(...args) {
  if (DEBUG) console.log(...args);
}

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
  console.log(`Finding partner for ${socket.id} in mode ${mode}`);
  
  // Получаем всех доступных партнеров
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
    
    console.log(`Creating room ${roomId} for users ${socket.id} and ${partnerId}`);

    // Удаляем обоих из ожидающих
    waitingUsers.delete(socket.id);
    waitingUsers.delete(partnerId);

    // Добавляем в активные
    activeUsers.set(socket.id, { roomId, partnerId, mode });
    activeUsers.set(partnerId, { roomId, partnerId: socket.id, mode });

    // Уведомляем обоих пользователей
    socket.emit('partnerFound', { partnerId, roomId });
    io.to(partnerId).emit('partnerFound', { partnerId: socket.id, roomId });

    console.log(`Room created: ${roomId}, mode: ${mode}`);
    logServerState();
    return true;
  }

  console.log(`No partners found for ${socket.id} in mode ${mode}`);
  return false;
}

io.on('connection', async (socket) => {
  debug('New client connected:', socket.id);

  // Проверяем, нет ли уже такого пользователя
  if (activeUsers.has(socket.id)) {
    console.log('User already exists, disconnecting old session:', socket.id);
    const oldSocket = io.sockets.sockets.get(socket.id);
    if (oldSocket) {
      oldSocket.disconnect(true);
    }
    activeUsers.delete(socket.id);
  }

  // Добавляем обработчик для получения возможностей маршрутизатора
  socket.on('getRouterRtpCapabilities', (callback) => {
    debug('Client requesting RTP capabilities:', socket.id);
    try {
      if (!router) {
        throw new Error('Router not initialized');
      }
      const rtpCapabilities = router.rtpCapabilities;
      debug('Sending RTP capabilities to client:', socket.id);
      debug('Capabilities:', rtpCapabilities);
      callback({ rtpCapabilities });
    } catch (error) {
      debug('Error getting RTP capabilities:', error);
      callback({ error: error.message });
    }
  });

  // Обработка готовности к поиску
  socket.on('ready', async (mode) => {
    debug('Client ready:', socket.id, 'mode:', mode);
    try {
      if (waitingUsers.has(socket.id) || activeUsers.has(socket.id)) {
        debug('Client already in waiting/active list:', socket.id);
        return;
      }

      // Добавляем в список ожидания
      waitingUsers.set(socket.id, {
        mode,
        joinedAt: Date.now(),
        socket
      });
      debug('Added to waiting list:', socket.id);

      // Ищем партнера
      const found = await findPartner(socket, mode);
      if (!found) {
        debug('No partner found, client waiting:', socket.id);
        socket.emit('waiting');
      }
    } catch (error) {
      debug('Error in ready handler:', error);
      socket.emit('error', { message: error.message });
    }
  });

  // Обработка подключения транспорта
  socket.on('connectWebRtcTransport', async ({ dtlsParameters, sender }, callback) => {
    debug('Connecting transport for client:', socket.id, 'sender:', sender);
    try {
      const transport = sender ? socket.producerTransport : socket.consumerTransport;
      if (!transport) {
        throw new Error(`${sender ? 'Producer' : 'Consumer'} transport not found`);
      }
      await transport.connect({ dtlsParameters });
      debug('Transport connected successfully');
      callback({ success: true });
    } catch (error) {
      debug('Error connecting transport:', error);
      callback({ error: error.message });
    }
  });

  // Обработка создания транспорта
  socket.on('createWebRtcTransport', async ({ sender }, callback) => {
    debug('Creating WebRTC transport for client:', socket.id, 'sender:', sender);
    try {
      const { transport, params } = await createWebRtcTransport();
      
      if (sender) {
        socket.producerTransport = transport;
        debug('Created producer transport:', transport.id);
      } else {
        socket.consumerTransport = transport;
        debug('Created consumer transport:', transport.id);
      }
      
      callback({ params });
    } catch (error) {
      debug('Error creating transport:', error);
      callback({ error: error.message });
    }
  });

  // Создание производителя
  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    debug('Client producing:', socket.id, 'kind:', kind);
    try {
      if (!socket.producerTransport) {
        throw new Error('Producer transport not found');
      }
      const producer = await socket.producerTransport.produce({ kind, rtpParameters });
      debug('Producer created:', producer.id);

      const userData = activeUsers.get(socket.id);
      if (userData?.partnerId) {
        debug('Notifying partner about new producer:', userData.partnerId);
        io.to(userData.partnerId).emit('newProducer', {
          producerId: producer.id,
          kind
        });
      }

      callback({ id: producer.id });
    } catch (error) {
      debug('Error in produce:', error);
      callback({ error: error.message });
    }
  });

  // Создание потребителя
  socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
    debug('Client consuming:', socket.id, 'producer:', producerId);
    try {
      if (!socket.consumerTransport) {
        throw new Error('Consumer transport not found');
      }

      const consumer = await socket.consumerTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true
      });

      debug('Consumer created:', consumer.id);
      callback({
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerId: consumer.producerId,
        type: consumer.type
      });
    } catch (error) {
      debug('Error in consume:', error);
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