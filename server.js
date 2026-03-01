const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { dbAsync, initTables } = require('./database');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const connectedUsers = new Map();
const activeRooms = new Map();

const defaultRooms = [
  { id: 'room001', name: '考研冲刺营', type: 'public', maxMembers: 30, tags: ['考研', '冲刺', '互相监督'] },
  { id: 'room002', name: '程序员自习室', type: 'public', maxMembers: 20, tags: ['编程', '技术', '学习'] },
  { id: 'room003', name: '英语角', type: 'private', password: '123456', maxMembers: 15, tags: ['英语', '口语', '阅读'] }
];

async function initDefaultRooms() {
  for (const room of defaultRooms) {
    const existing = await dbAsync.get('SELECT id FROM rooms WHERE id = ?', [room.id]);
    if (!existing) {
      await dbAsync.run(
        'INSERT INTO rooms (id, name, type, password, max_members, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [room.id, room.name, room.type, room.password || null, room.maxMembers, JSON.stringify(room.tags), Date.now()]
      );
    }
    activeRooms.set(room.id, { ...room, members: new Map() });
  }
}

async function startServer() {
  await initTables();
  await initDefaultRooms();
  
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
    console.log(`📚 在线自习室已启动`);
  });
}

startServer().catch(err => {
  console.error('服务器启动失败:', err);
  process.exit(1);
});

app.post('/api/register', async (req, res) => {
  const { username, password, nickname, avatar } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码必填' });
  }

  try {
    const existing = await dbAsync.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    const userId = uuidv4();
    await dbAsync.run(
      'INSERT INTO users (id, username, password, nickname, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, username, password, nickname || username, avatar || '📚', Date.now()]
    );

    const user = {
      id: userId,
      username,
      nickname: nickname || username,
      avatar: avatar || '📚',
      totalStudyTime: 0,
      studyDays: 0,
      weeklyData: [0, 0, 0, 0, 0, 0, 0],
      lastStudyDate: null
    };

    res.json({ 
      success: true, 
      user,
      token: userId
    });
  } catch (err) {
    console.error('注册错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await dbAsync.get(
      'SELECT * FROM users WHERE username = ? AND password = ?',
      [username, password]
    );

    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    res.json({ 
      success: true, 
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        avatar: user.avatar,
        totalStudyTime: user.total_study_time || 0,
        studyDays: user.study_days || 0,
        weeklyData: JSON.parse(user.weekly_data || '[0,0,0,0,0,0,0]'),
        lastStudyDate: user.last_study_date
      },
      token: user.id
    });
  } catch (err) {
    console.error('登录错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    res.json({
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar,
      totalStudyTime: user.total_study_time || 0,
      studyDays: user.study_days || 0,
      weeklyData: JSON.parse(user.weekly_data || '[0,0,0,0,0,0,0]'),
      lastStudyDate: user.last_study_date
    });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.put('/api/user/:id', async (req, res) => {
  const { nickname, avatar } = req.body;
  
  try {
    await dbAsync.run(
      'UPDATE users SET nickname = COALESCE(?, nickname), avatar = COALESCE(?, avatar) WHERE id = ?',
      [nickname, avatar, req.params.id]
    );
    
    const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.json({
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar,
      totalStudyTime: user.total_study_time || 0,
      studyDays: user.study_days || 0,
      weeklyData: JSON.parse(user.weekly_data || '[0,0,0,0,0,0,0]')
    });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await dbAsync.all('SELECT * FROM rooms');
    const roomsList = rooms.map(room => ({
      id: room.id,
      name: room.name,
      type: room.type,
      maxMembers: room.max_members,
      tags: JSON.parse(room.tags || '[]'),
      memberCount: activeRooms.get(room.id)?.members?.size || 0
    }));
    res.json(roomsList);
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/rooms', async (req, res) => {
  const { name, type, password, maxMembers, tags, userId } = req.body;

  if (!name) {
    return res.status(400).json({ error: '房间名称必填' });
  }

  const roomId = 'room' + Date.now().toString().slice(-6);
  
  try {
    await dbAsync.run(
      'INSERT INTO rooms (id, name, type, password, max_members, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [roomId, name, type || 'public', type === 'private' ? password : null, maxMembers || 20, JSON.stringify(tags || ['学习']), userId, Date.now()]
    );

    activeRooms.set(roomId, {
      id: roomId,
      name,
      type: type || 'public',
      password: type === 'private' ? password : null,
      maxMembers: maxMembers || 20,
      tags: tags || ['学习'],
      members: new Map()
    });

    res.json({ 
      success: true, 
      room: { id: roomId, name, type: type || 'public', maxMembers: maxMembers || 20, tags: tags || ['学习'] }
    });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/rooms/:id', async (req, res) => {
  try {
    const room = await dbAsync.get('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    res.json({
      id: room.id,
      name: room.name,
      type: room.type,
      maxMembers: room.max_members,
      tags: JSON.parse(room.tags || '[]'),
      memberCount: activeRooms.get(room.id)?.members?.size || 0
    });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/rooms/:id/leaderboard', (req, res) => {
  const room = activeRooms.get(req.params.id);
  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }

  const leaderboard = Array.from(room.members.values())
    .map(member => ({
      userId: member.userId,
      nickname: member.nickname,
      avatar: member.avatar,
      studyTime: member.studyTime || 0
    }))
    .sort((a, b) => b.studyTime - a.studyTime);

  res.json(leaderboard);
});

app.get('/api/tasks/:userId', async (req, res) => {
  try {
    const tasks = await dbAsync.all('SELECT * FROM tasks WHERE user_id = ?', [req.params.userId]);
    res.json(tasks.map(t => ({
      id: t.id,
      title: t.title,
      completed: t.completed === 1,
      createdAt: t.created_at
    })));
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/tasks/:userId', async (req, res) => {
  const { title } = req.body;
  if (!title) {
    return res.status(400).json({ error: '任务标题必填' });
  }

  const taskId = uuidv4();
  
  try {
    await dbAsync.run(
      'INSERT INTO tasks (id, user_id, title, completed, created_at) VALUES (?, ?, ?, 0, ?)',
      [taskId, req.params.userId, title, Date.now()]
    );
    
    res.json({ id: taskId, title, completed: false, createdAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.put('/api/tasks/:userId/:taskId', async (req, res) => {
  const { userId, taskId } = req.params;
  const { title, completed } = req.body;

  try {
    if (title !== undefined) {
      await dbAsync.run('UPDATE tasks SET title = ? WHERE id = ? AND user_id = ?', [title, taskId, userId]);
    }
    if (completed !== undefined) {
      await dbAsync.run('UPDATE tasks SET completed = ? WHERE id = ? AND user_id = ?', [completed ? 1 : 0, taskId, userId]);
    }
    
    const task = await dbAsync.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [taskId, userId]);
    res.json({
      id: task.id,
      title: task.title,
      completed: task.completed === 1,
      createdAt: task.created_at
    });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.delete('/api/tasks/:userId/:taskId', async (req, res) => {
  const { userId, taskId } = req.params;
  
  try {
    await dbAsync.run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [taskId, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  socket.userId = null;
  socket.currentRoom = null;

  socket.on('register', (userData) => {
    socket.userId = userData.id;
    socket.userData = userData;
    connectedUsers.set(socket.id, userData);
    console.log('用户注册:', userData.nickname);
  });

  socket.on('join-room', async (data, callback) => {
    const { roomId, userId, password } = data;
    const room = activeRooms.get(roomId);

    if (!room) {
      const dbRoom = await dbAsync.get('SELECT * FROM rooms WHERE id = ?', [roomId]);
      if (!dbRoom) {
        return callback?.({ error: '房间不存在' });
      }
      activeRooms.set(roomId, {
        id: dbRoom.id,
        name: dbRoom.name,
        type: dbRoom.type,
        password: dbRoom.password,
        maxMembers: dbRoom.max_members,
        tags: JSON.parse(dbRoom.tags || '[]'),
        members: new Map()
      });
    }

    const activeRoom = activeRooms.get(roomId);
    
    if (activeRoom.type === 'private' && activeRoom.password !== password) {
      return callback?.({ error: '密码错误' });
    }

    if (activeRoom.members.size >= activeRoom.maxMembers) {
      return callback?.({ error: '房间已满' });
    }

    if (socket.currentRoom) {
      leaveRoom(socket);
    }

    socket.join(roomId);
    socket.currentRoom = roomId;

    let user = socket.userData;
    if (userId) {
      const dbUser = await dbAsync.get('SELECT * FROM users WHERE id = ?', [userId]);
      if (dbUser) {
        user = {
          id: dbUser.id,
          nickname: dbUser.nickname,
          avatar: dbUser.avatar
        };
      }
    }

    const memberData = {
      socketId: socket.id,
      userId: userId,
      nickname: user?.nickname || '用户',
      avatar: user?.avatar || '📚',
      joinTime: Date.now(),
      studyTime: 0,
      isIdle: false
    };

    activeRoom.members.set(socket.id, memberData);

    const membersList = Array.from(activeRoom.members.values());
    
    callback?.({ 
      success: true, 
      room: {
        id: activeRoom.id,
        name: activeRoom.name,
        members: membersList
      }
    });

    socket.to(roomId).emit('user-joined', memberData);
    io.to(roomId).emit('room-update', { memberCount: activeRoom.members.size });
    broadcastLeaderboard(roomId);
  });

  socket.on('leave-room', () => {
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    console.log('用户断开:', socket.id);
    leaveRoom(socket);
    connectedUsers.delete(socket.id);
  });

  function leaveRoom(socket) {
    if (!socket.currentRoom) return;

    const roomId = socket.currentRoom;
    const room = activeRooms.get(roomId);
    if (room) {
      room.members.delete(socket.id);
      io.to(roomId).emit('user-left', { socketId: socket.id });
      io.to(roomId).emit('room-update', { memberCount: room.members.size });
      broadcastLeaderboard(roomId);
    }

    socket.leave(roomId);
    socket.currentRoom = null;
  }

  function broadcastLeaderboard(roomId) {
    const room = activeRooms.get(roomId);
    if (!room) return;

    const leaderboard = Array.from(room.members.values())
      .map(member => ({
        userId: member.userId,
        nickname: member.nickname,
        avatar: member.avatar,
        studyTime: member.studyTime || 0
      }))
      .sort((a, b) => b.studyTime - a.studyTime);

    io.to(roomId).emit('leaderboard-update', leaderboard);
  }

  socket.on('update-study-time', (data) => {
    if (!socket.currentRoom) return;

    const room = activeRooms.get(socket.currentRoom);
    if (room && room.members.has(socket.id)) {
      const member = room.members.get(socket.id);
      member.studyTime = data.studyTime;
      member.isIdle = data.isIdle || false;

      io.to(socket.currentRoom).emit('member-updated', {
        socketId: socket.id,
        userId: member.userId,
        studyTime: data.studyTime,
        isIdle: data.isIdle
      });

      if (data.studyTime % 30 === 0) {
        broadcastLeaderboard(socket.currentRoom);
      }
    }
  });

  socket.on('save-study-time', async (data) => {
    try {
      const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [data.userId]);
      if (user) {
        const totalTime = (user.total_study_time || 0) + data.seconds;
        const today = new Date().toISOString().split('T')[0];
        let studyDays = user.study_days || 0;
        
        if (user.last_study_date !== today) {
          studyDays++;
        }
        
        const weeklyData = JSON.parse(user.weekly_data || '[0,0,0,0,0,0,0]');
        const dayIndex = new Date().getDay();
        weeklyData[dayIndex] += data.seconds;

        await dbAsync.run(
          'UPDATE users SET total_study_time = ?, study_days = ?, last_study_date = ?, weekly_data = ? WHERE id = ?',
          [totalTime, studyDays, today, JSON.stringify(weeklyData), data.userId]
        );
      }
    } catch (err) {
      console.error('保存学习时间错误:', err);
    }
  });

  socket.on('webrtc-offer', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-offer', {
      offer: data.offer,
      socketId: socket.id
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-answer', {
      answer: data.answer,
      socketId: socket.id
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
      socketId: socket.id
    });
  });

  socket.on('toggle-media', (data) => {
    if (!socket.currentRoom) return;
    socket.to(socket.currentRoom).emit('peer-media-toggle', {
      socketId: socket.id,
      videoEnabled: data.videoEnabled,
      audioEnabled: data.audioEnabled
    });
  });

  socket.on('send-emoji', (data) => {
    const { targetSocketId, emoji, sender } = data;

    if (targetSocketId === 'all') {
      io.to(socket.currentRoom).emit('receive-emoji', {
        emoji,
        sender,
        fromSocketId: socket.id
      });
    } else {
      io.to(targetSocketId).emit('receive-emoji', {
        emoji,
        sender,
        fromSocketId: socket.id
      });
    }
  });

  socket.on('send-message', (data) => {
    if (!socket.currentRoom) return;

    io.to(socket.currentRoom).emit('receive-message', {
      socketId: socket.id,
      userId: socket.userId,
      nickname: data.nickname,
      message: data.message,
      time: Date.now()
    });
  });
});
