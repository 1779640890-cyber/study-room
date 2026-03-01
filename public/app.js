const AVATARS = ['📚', '📖', '✏️', '🎓', '💡', '🔬', '💻', '🎯', '⭐', '🌟', '🔥', '💪'];
const SERVER_URL = window.location.origin;

let socket = null;
let currentUser = null;
let currentRoom = null;
let studyTimer = null;
let studySeconds = 0;
let isPaused = false;
let cameraEnabled = true;
let micEnabled = true;
let selectedMember = null;
let selectedEmoji = null;
let localStream = null;
let peerConnections = new Map();

function init() {
    const token = localStorage.getItem('study_room_token');
    if (token) {
        fetchUser(token);
    }
    setupRoomTypeListener();
}

async function fetchUser(token) {
    try {
        const res = await fetch(`${SERVER_URL}/api/user/${token}`);
        if (res.ok) {
            const data = await res.json();
            currentUser = data;
            connectSocket();
            showLobby();
        }
    } catch (err) {
        console.error('获取用户信息失败:', err);
    }
}

function connectSocket() {
    socket = io(SERVER_URL);
    
    socket.on('connect', () => {
        console.log('Socket 连接成功:', socket.id);
        if (currentUser) {
            socket.emit('register', currentUser);
        }
    });

    socket.on('disconnect', () => {
        console.log('Socket 断开连接');
    });

    socket.on('user-joined', (member) => {
        console.log('用户加入:', member.nickname);
        addVideoCard(member);
        addMemberToList(member);
        updateMemberCount();
        
        if (localStream) {
            createPeerConnection(member.socketId, true);
        }
    });

    socket.on('user-left', (data) => {
        console.log('用户离开:', data.socketId);
        removeVideoCard(data.socketId);
        removeMemberFromList(data.socketId);
        closePeerConnection(data.socketId);
        updateMemberCount();
    });

    socket.on('member-updated', (data) => {
        updateMemberStatus(data);
    });

    socket.on('room-update', (data) => {
        document.getElementById('membersCount').textContent = `${data.memberCount}人在线`;
    });

    socket.on('webrtc-offer', async (data) => {
        await handleOffer(data);
    });

    socket.on('webrtc-answer', async (data) => {
        await handleAnswer(data);
    });

    socket.on('webrtc-ice-candidate', async (data) => {
        await handleIceCandidate(data);
    });

    socket.on('peer-media-toggle', (data) => {
        updatePeerMediaStatus(data);
    });

    socket.on('receive-emoji', (data) => {
        showEmojiAlert(data.emoji, data.sender);
    });

    socket.on('receive-message', (data) => {
        addChatMessage(data);
    });

    socket.on('leaderboard-update', () => {
        loadLeaderboard();
    });
}

async function handleOffer(data) {
    const pc = createPeerConnection(data.socketId, false);
    
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        socket.emit('webrtc-answer', {
            targetSocketId: data.socketId,
            answer: answer
        });
    } catch (err) {
        console.error('处理 Offer 失败:', err);
    }
}

async function handleAnswer(data) {
    const pc = peerConnections.get(data.socketId);
    if (pc) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (err) {
            console.error('处理 Answer 失败:', err);
        }
    }
}

async function handleIceCandidate(data) {
    const pc = peerConnections.get(data.socketId);
    if (pc) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
            console.error('处理 ICE Candidate 失败:', err);
        }
    }
}

function createPeerConnection(socketId, isInitiator) {
    if (peerConnections.has(socketId)) {
        return peerConnections.get(socketId);
    }

    const config = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    const pc = new RTCPeerConnection(config);
    peerConnections.set(socketId, pc);

    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-ice-candidate', {
                targetSocketId: socketId,
                candidate: event.candidate
            });
        }
    };

    pc.ontrack = (event) => {
        const video = document.querySelector(`.video-card[data-socket-id="${socketId}"] video`);
        if (video) {
            video.srcObject = event.streams[0];
            video.play().catch(err => console.log('视频播放失败:', err));
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`PeerConnection ${socketId} 状态:`, pc.connectionState);
    };

    if (isInitiator) {
        pc.onnegotiationneeded = async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('webrtc-offer', {
                    targetSocketId: socketId,
                    offer: offer
                });
            } catch (err) {
                console.error('创建 Offer 失败:', err);
            }
        };
    }

    return pc;
}

function closePeerConnection(socketId) {
    const pc = peerConnections.get(socketId);
    if (pc) {
        pc.close();
        peerConnections.delete(socketId);
    }
}

function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    if (tab === 'login') {
        document.getElementById('loginForm').classList.remove('hidden');
        document.getElementById('registerForm').classList.add('hidden');
    } else {
        document.getElementById('loginForm').classList.add('hidden');
        document.getElementById('registerForm').classList.remove('hidden');
    }
}

function changeAvatar() {
    const current = AVATARS.indexOf(document.getElementById('avatarEmoji').textContent);
    const next = (current + 1) % AVATARS.length;
    document.getElementById('avatarEmoji').textContent = AVATARS[next];
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;

    try {
        const res = await fetch(`${SERVER_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (!res.ok) {
            showToast(data.error, 'error');
            return;
        }

        currentUser = data.user;
        localStorage.setItem('study_room_token', data.token);
        connectSocket();
        showLobby();
        showToast('登录成功！');
    } catch (err) {
        showToast('登录失败', 'error');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('regUsername').value;
    const nickname = document.getElementById('regNickname').value || username;
    const password = document.getElementById('regPassword').value;
    const confirmPassword = document.getElementById('regConfirmPassword').value;
    const avatar = document.getElementById('avatarEmoji').textContent;

    if (password !== confirmPassword) {
        showToast('两次密码不一致', 'error');
        return;
    }

    try {
        const res = await fetch(`${SERVER_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, nickname, avatar })
        });

        const data = await res.json();

        if (!res.ok) {
            showToast(data.error, 'error');
            return;
        }

        currentUser = data.user;
        localStorage.setItem('study_room_token', data.token);
        connectSocket();
        showLobby();
        showToast('注册成功！');
    } catch (err) {
        showToast('注册失败', 'error');
    }
}

function logout() {
    localStorage.removeItem('study_room_token');
    currentUser = null;
    if (socket) {
        socket.disconnect();
    }
    document.getElementById('authPage').classList.remove('hidden');
    document.getElementById('lobbyPage').classList.add('hidden');
    document.getElementById('studyRoomPage').classList.add('hidden');
}

async function showLobby() {
    document.getElementById('authPage').classList.add('hidden');
    document.getElementById('lobbyPage').classList.remove('hidden');
    document.getElementById('studyRoomPage').classList.add('hidden');
    
    document.getElementById('userAvatar').textContent = currentUser.avatar;
    document.getElementById('userNickname').textContent = currentUser.nickname;
    document.getElementById('totalStudyTime').textContent = formatHours(currentUser.totalStudyTime);
    document.getElementById('studyDays').textContent = currentUser.studyDays;
    
    await loadRooms();
}

async function loadRooms() {
    try {
        const res = await fetch(`${SERVER_URL}/api/rooms`);
        const rooms = await res.json();
        
        const grid = document.getElementById('roomsGrid');
        grid.innerHTML = rooms.map(room => `
            <div class="room-card" onclick="joinRoomDirect('${room.id}')">
                <div class="room-header">
                    <span class="room-name">${room.name}</span>
                    <span class="room-status ${room.type}">${room.type === 'public' ? '公开' : '私密'}</span>
                </div>
                <div class="room-info">
                    <span>👥 ${room.memberCount}/${room.maxMembers}</span>
                    <span>🆔 ${room.id}</span>
                </div>
                <div class="room-tags">
                    ${room.tags.map(tag => `<span class="room-tag">${tag}</span>`).join('')}
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('加载房间失败:', err);
    }
}

function setupRoomTypeListener() {
    document.querySelectorAll('input[name="roomType"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            document.getElementById('roomPasswordGroup').classList.toggle('hidden', e.target.value === 'public');
        });
    });
}

function showCreateRoomModal() {
    document.getElementById('createRoomModal').classList.add('active');
}

function showJoinRoomModal() {
    document.getElementById('joinRoomModal').classList.add('active');
}

function showStatsModal() {
    renderWeeklyChart();
    document.getElementById('statsModal').classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

async function createRoom() {
    const name = document.getElementById('roomName').value || '我的自习室';
    const maxMembers = parseInt(document.getElementById('maxMembers').value) || 20;
    const type = document.querySelector('input[name="roomType"]:checked').value;
    const password = document.getElementById('roomPassword').value;
    const tags = document.getElementById('roomTags').value.split(',').map(t => t.trim()).filter(t => t);

    try {
        const res = await fetch(`${SERVER_URL}/api/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                type,
                password,
                maxMembers,
                tags,
                userId: currentUser.id
            })
        });

        const data = await res.json();

        if (!res.ok) {
            showToast(data.error, 'error');
            return;
        }

        closeModal('createRoomModal');
        showToast('自习室创建成功！');
        loadRooms();
    } catch (err) {
        showToast('创建失败', 'error');
    }
}

function joinRoomDirect(roomId) {
    document.getElementById('joinRoomId').value = roomId;
    
    fetch(`${SERVER_URL}/api/rooms/${roomId}`)
        .then(res => res.json())
        .then(room => {
            if (room.type === 'private') {
                document.getElementById('joinPasswordGroup').classList.remove('hidden');
                showJoinRoomModal();
            } else {
                enterRoom(roomId);
            }
        });
}

function joinRoom() {
    const roomId = document.getElementById('joinRoomId').value;
    const password = document.getElementById('joinPassword').value;
    enterRoom(roomId, password);
}

function enterRoom(roomId, password = null) {
    if (!socket || !socket.connected) {
        showToast('未连接服务器', 'error');
        return;
    }

    socket.emit('join-room', {
        roomId,
        userId: currentUser.id,
        password
    }, (response) => {
        if (response.error) {
            showToast(response.error, 'error');
            return;
        }

        currentRoom = response.room;
        
        document.getElementById('lobbyPage').classList.add('hidden');
        document.getElementById('studyRoomPage').classList.remove('hidden');
        document.getElementById('currentRoomName').textContent = currentRoom.name;
        document.getElementById('membersCount').textContent = `${currentRoom.members.length}人在线`;

        startTimer();
        initMedia();
        renderVideoGrid(currentRoom.members);
        renderMembers(currentRoom.members);
        initEmojiPanel();
        loadLeaderboard();
        loadTasks();
    });

    closeModal('joinRoomModal');
}

async function initMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: 720, height: 480, frameRate: 15 }, 
            audio: true 
        });
        
        const selfVideo = document.querySelector('.video-card.self video');
        if (selfVideo) {
            selfVideo.srcObject = localStream;
            selfVideo.play().catch(err => console.log('本地视频播放失败:', err));
        }

        currentRoom.members.forEach(member => {
            if (member.socketId !== socket.id) {
                createPeerConnection(member.socketId, true);
            }
        });
    } catch (err) {
        console.log('摄像头访问失败:', err);
        showToast('无法访问摄像头', 'error');
    }
}

function renderVideoGrid(members) {
    const grid = document.getElementById('videoGrid');
    
    let html = `
        <div class="video-card self" data-socket-id="${socket?.id || 'self'}">
            <video autoplay muted playsinline></video>
            <div class="video-info">
                <span class="video-name">${currentUser.nickname} (我)</span>
                <span class="video-time" id="selfStudyTime">00:00:00</span>
            </div>
        </div>
    `;

    members.forEach(member => {
        if (member.socketId !== socket?.id) {
            html += `
                <div class="video-card ${member.isIdle ? 'idle' : ''}" 
                     data-socket-id="${member.socketId}" 
                     data-user-id="${member.userId}">
                    <video autoplay playsinline></video>
                    <div class="video-placeholder">
                        <div class="avatar">${member.avatar}</div>
                        <span>${member.nickname}</span>
                    </div>
                    <div class="video-info">
                        <span class="video-name">${member.nickname}</span>
                        <div class="video-status">
                            <span class="status-dot ${member.isIdle ? 'idle' : ''}"></span>
                            <span>${member.isIdle ? '疑似偷懒' : '学习中'}</span>
                        </div>
                        <span class="video-time">${formatHours(member.studyTime || 0)}</span>
                    </div>
                </div>
            `;
        }
    });

    grid.innerHTML = html;
}

function addVideoCard(member) {
    const grid = document.getElementById('videoGrid');
    
    const card = document.createElement('div');
    card.className = `video-card ${member.isIdle ? 'idle' : ''}`;
    card.dataset.socketId = member.socketId;
    card.dataset.userId = member.userId;
    
    card.innerHTML = `
        <video autoplay playsinline></video>
        <div class="video-placeholder">
            <div class="avatar">${member.avatar}</div>
            <span>${member.nickname}</span>
        </div>
        <div class="video-info">
            <span class="video-name">${member.nickname}</span>
            <div class="video-status">
                <span class="status-dot ${member.isIdle ? 'idle' : ''}"></span>
                <span>${member.isIdle ? '疑似偷懒' : '学习中'}</span>
            </div>
            <span class="video-time">${formatHours(member.studyTime || 0)}</span>
        </div>
    `;
    
    grid.appendChild(card);
}

function removeVideoCard(socketId) {
    const card = document.querySelector(`.video-card[data-socket-id="${socketId}"]`);
    if (card) {
        card.remove();
    }
}

function renderMembers(members) {
    const list = document.getElementById('membersTab');

    list.innerHTML = members.map(member => `
        <div class="member-item ${selectedMember === member.socketId ? 'selected' : ''}" 
             onclick="selectMember('${member.socketId}')" 
             data-socket-id="${member.socketId}">
            <div class="member-avatar">${member.avatar}</div>
            <div class="member-info">
                <div class="member-name">${member.nickname}${member.socketId === socket?.id ? ' (我)' : ''}</div>
                <div class="member-time">${formatHours(member.studyTime || 0)}</div>
            </div>
            ${member.isIdle ? '<span style="color: var(--warning);">⚠️</span>' : ''}
        </div>
    `).join('');
}

function addMemberToList(member) {
    const list = document.getElementById('membersTab');
    
    const item = document.createElement('div');
    item.className = 'member-item';
    item.dataset.socketId = member.socketId;
    item.onclick = () => selectMember(member.socketId);
    
    item.innerHTML = `
        <div class="member-avatar">${member.avatar}</div>
        <div class="member-info">
            <div class="member-name">${member.nickname}</div>
            <div class="member-time">${formatHours(member.studyTime || 0)}</div>
        </div>
    `;
    
    list.appendChild(item);
}

function removeMemberFromList(socketId) {
    const item = document.querySelector(`.member-item[data-socket-id="${socketId}"]`);
    if (item) {
        item.remove();
    }
}

function updateMemberCount() {
    const count = document.querySelectorAll('.video-card').length;
    document.getElementById('membersCount').textContent = `${count}人在线`;
}

function updateMemberStatus(data) {
    const card = document.querySelector(`.video-card[data-socket-id="${data.socketId}"]`);
    if (card) {
        card.classList.toggle('idle', data.isIdle);
        
        const statusDot = card.querySelector('.status-dot');
        const statusText = card.querySelector('.video-status span:last-child');
        const timeSpan = card.querySelector('.video-time');
        
        if (statusDot) statusDot.classList.toggle('idle', data.isIdle);
        if (statusText) statusText.textContent = data.isIdle ? '疑似偷懒' : '学习中';
        if (timeSpan) timeSpan.textContent = formatHours(data.studyTime);
    }

    const memberItem = document.querySelector(`.member-item[data-socket-id="${data.socketId}"]`);
    if (memberItem) {
        const timeDiv = memberItem.querySelector('.member-time');
        if (timeDiv) timeDiv.textContent = formatHours(data.studyTime);
    }
}

function updatePeerMediaStatus(data) {
    const card = document.querySelector(`.video-card[data-socket-id="${data.socketId}"]`);
    if (card) {
        const video = card.querySelector('video');
        const placeholder = card.querySelector('.video-placeholder');
        
        if (!data.videoEnabled) {
            if (video) video.style.display = 'none';
            if (placeholder) placeholder.style.display = 'flex';
        } else {
            if (video) video.style.display = 'block';
            if (placeholder) placeholder.style.display = 'none';
        }
    }
}

function selectMember(socketId) {
    selectedMember = selectedMember === socketId ? null : socketId;
    
    document.querySelectorAll('.member-item').forEach(item => {
        item.classList.toggle('selected', item.dataset.socketId === selectedMember);
    });
}

function leaveRoom() {
    if (studyTimer) {
        clearInterval(studyTimer);
        studyTimer = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    peerConnections.forEach((pc, socketId) => {
        pc.close();
    });
    peerConnections.clear();

    if (socket) {
        socket.emit('save-study-time', {
            userId: currentUser.id,
            seconds: studySeconds
        });
        socket.emit('leave-room');
    }

    currentUser.totalStudyTime += studySeconds;
    
    const today = new Date().toISOString().split('T')[0];
    if (currentUser.lastStudyDate !== today) {
        currentUser.studyDays++;
        currentUser.lastStudyDate = today;
    }
    
    const dayIndex = new Date().getDay();
    currentUser.weeklyData[dayIndex] += studySeconds;

    studySeconds = 0;
    currentRoom = null;

    showLobby();
}

function startTimer() {
    studyTimer = setInterval(() => {
        if (!isPaused) {
            studySeconds++;
            updateTimerDisplay();
            
            document.getElementById('selfStudyTime').textContent = 
                formatTime(studySeconds);
            
            if (socket && studySeconds % 5 === 0) {
                socket.emit('update-study-time', {
                    studyTime: studySeconds,
                    isIdle: false
                });
            }
        }
    }, 1000);
}

function toggleTimer() {
    isPaused = !isPaused;
    document.getElementById('pauseBtn').textContent = isPaused ? '▶' : '⏸';
    document.getElementById('pauseBtn').classList.toggle('active', isPaused);
}

function updateTimerDisplay() {
    document.getElementById('timerDisplay').textContent = formatTime(studySeconds);
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatHours(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}小时${minutes}分`;
    }
    return `${minutes}分钟`;
}

function toggleCamera() {
    cameraEnabled = !cameraEnabled;
    if (localStream) {
        localStream.getVideoTracks().forEach(track => {
            track.enabled = cameraEnabled;
        });
    }
    document.getElementById('cameraBtn').classList.toggle('active', !cameraEnabled);
    document.getElementById('cameraBtn').textContent = cameraEnabled ? '📷' : '🚫';
    
    if (socket) {
        socket.emit('toggle-media', {
            videoEnabled: cameraEnabled,
            audioEnabled: micEnabled
        });
    }

    const selfVideo = document.querySelector('.video-card.self video');
    const selfPlaceholder = document.querySelector('.video-card.self .video-placeholder');
    if (selfVideo && selfPlaceholder) {
        if (cameraEnabled) {
            selfVideo.style.display = 'block';
            selfPlaceholder.style.display = 'none';
        } else {
            selfVideo.style.display = 'none';
            selfPlaceholder.style.display = 'flex';
        }
    }
}

function toggleMic() {
    micEnabled = !micEnabled;
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = micEnabled;
        });
    }
    document.getElementById('micBtn').classList.toggle('active', !micEnabled);
    document.getElementById('micBtn').textContent = micEnabled ? '🎤' : '🔇';
    
    if (socket) {
        socket.emit('toggle-media', {
            videoEnabled: cameraEnabled,
            audioEnabled: micEnabled
        });
    }
}

function initEmojiPanel() {
    const emojis = ['😴', '👀', '💪', '🔥', '📚', '⏰', '🎯', '加油'];
    const panel = document.getElementById('emojiPanel');
    
    panel.innerHTML = emojis.map(emoji => `
        <div class="emoji-item ${selectedEmoji === emoji ? 'selected' : ''}" 
             onclick="selectEmoji('${emoji}')">${emoji}</div>
    `).join('');
}

function selectEmoji(emoji) {
    selectedEmoji = selectedEmoji === emoji ? null : emoji;
    initEmojiPanel();
}

function sendEmoji() {
    if (!selectedMember) {
        showToast('请先选择一个成员', 'error');
        return;
    }
    if (!selectedEmoji) {
        showToast('请选择一个表情', 'error');
        return;
    }

    socket.emit('send-emoji', {
        targetSocketId: selectedMember,
        emoji: selectedEmoji,
        sender: currentUser.nickname
    });

    showToast(`已发送 ${selectedEmoji}`);
    selectedMember = null;
    selectedEmoji = null;
    renderMembers(currentRoom?.members || []);
    initEmojiPanel();
}

function showEmojiAlert(emoji, sender) {
    const alert = document.getElementById('emojiAlert');
    document.getElementById('alertEmoji').textContent = emoji;
    document.getElementById('alertSender').textContent = `来自 ${sender}`;
    
    alert.classList.remove('show');
    void alert.offsetWidth;
    alert.classList.add('show');
    
    playNotificationSound();

    setTimeout(() => {
        alert.classList.remove('show');
    }, 5000);
}

function playNotificationSound() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(600, audioContext.currentTime + 0.1);
    oscillator.frequency.setValueAtTime(800, audioContext.currentTime + 0.2);
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.4);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.4);
}

function sendChatMessage(e) {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    
    if (!message || !socket) return;

    socket.emit('send-message', {
        nickname: currentUser.nickname,
        message: message
    });

    input.value = '';
}

function addChatMessage(data) {
    const messages = document.getElementById('chatMessages');
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message';
    msgDiv.innerHTML = `
        <div class="sender">${data.nickname}</div>
        <div class="content">${data.message}</div>
        <div class="time">${new Date(data.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
    `;
    
    messages.appendChild(msgDiv);
    messages.scrollTop = messages.scrollHeight;
}

function renderWeeklyChart() {
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    const chart = document.getElementById('weeklyChart');
    
    const maxTime = Math.max(...currentUser.weeklyData, 3600);
    
    chart.innerHTML = currentUser.weeklyData.map((time, i) => {
        const height = (time / maxTime) * 100;
        return `<div class="chart-bar" style="height: ${Math.max(height, 5)}%;" data-day="${days[i]}"></div>`;
    }).join('');

    const weekTotal = currentUser.weeklyData.reduce((a, b) => a + b, 0);
    document.getElementById('weekTotal').textContent = formatHours(weekTotal);
    document.getElementById('avgDaily').textContent = formatHours(weekTotal / 7);
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

let tasks = [];

async function loadTasks() {
    try {
        const res = await fetch(`${SERVER_URL}/api/tasks/${currentUser.id}`);
        tasks = await res.json();
        renderTasks();
    } catch (err) {
        console.error('加载任务失败:', err);
    }
}

function renderTasks() {
    const content = document.getElementById('tasksContent');
    const modalList = document.getElementById('modalTasksList');
    
    if (tasks.length === 0) {
        const emptyHtml = '<div class="empty-state">暂无任务，点击添加</div>';
        content.innerHTML = emptyHtml;
        if (modalList) modalList.innerHTML = emptyHtml;
        return;
    }
    
    const tasksHtml = tasks.map(task => `
        <div class="task-item ${task.completed ? 'completed' : ''}" data-task-id="${task.id}">
            <div class="task-checkbox ${task.completed ? 'checked' : ''}" onclick="toggleTask('${task.id}')">
                ${task.completed ? '✓' : ''}
            </div>
            <span class="task-title">${escapeHtml(task.title)}</span>
            <button class="task-delete" onclick="deleteTask('${task.id}')">✕</button>
        </div>
    `).join('');
    
    content.innerHTML = tasksHtml;
    if (modalList) modalList.innerHTML = tasksHtml;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showAddTaskInput() {
    document.getElementById('addTaskArea').classList.remove('hidden');
    document.getElementById('newTaskInput').focus();
}

function hideAddTaskInput() {
    document.getElementById('addTaskArea').classList.add('hidden');
    document.getElementById('newTaskInput').value = '';
}

function handleTaskKeypress(e) {
    if (e.key === 'Enter') {
        addTask();
    }
}

async function addTask() {
    const input = document.getElementById('newTaskInput');
    const title = input.value.trim();
    
    if (!title) {
        showToast('请输入任务内容', 'error');
        return;
    }
    
    try {
        const res = await fetch(`${SERVER_URL}/api/tasks/${currentUser.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        
        const newTask = await res.json();
        tasks.push(newTask);
        renderTasks();
        hideAddTaskInput();
        showToast('任务添加成功');
    } catch (err) {
        showToast('添加失败', 'error');
    }
}

async function toggleTask(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    try {
        const res = await fetch(`${SERVER_URL}/api/tasks/${currentUser.id}/${taskId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed: !task.completed })
        });
        
        const updatedTask = await res.json();
        const index = tasks.findIndex(t => t.id === taskId);
        tasks[index] = updatedTask;
        renderTasks();
    } catch (err) {
        showToast('操作失败', 'error');
    }
}

async function deleteTask(taskId) {
    try {
        await fetch(`${SERVER_URL}/api/tasks/${currentUser.id}/${taskId}`, {
            method: 'DELETE'
        });
        
        tasks = tasks.filter(t => t.id !== taskId);
        renderTasks();
        showToast('任务已删除');
    } catch (err) {
        showToast('删除失败', 'error');
    }
}

function showTasksModal() {
    loadTasks();
    document.getElementById('tasksModal').classList.add('active');
}

function handleModalTaskKeypress(e) {
    if (e.key === 'Enter') {
        addTaskFromModal();
    }
}

async function addTaskFromModal() {
    const input = document.getElementById('modalTaskInput');
    const title = input.value.trim();
    
    if (!title) {
        showToast('请输入任务内容', 'error');
        return;
    }
    
    try {
        const res = await fetch(`${SERVER_URL}/api/tasks/${currentUser.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        
        const newTask = await res.json();
        tasks.push(newTask);
        renderTasks();
        input.value = '';
        showToast('任务添加成功');
    } catch (err) {
        showToast('添加失败', 'error');
    }
}

async function loadLeaderboard() {
    if (!currentRoom) return;
    
    try {
        const res = await fetch(`${SERVER_URL}/api/rooms/${currentRoom.id}/leaderboard`);
        const leaderboard = await res.json();
        renderLeaderboard(leaderboard);
    } catch (err) {
        console.error('加载排行榜失败:', err);
    }
}

function renderLeaderboard(leaderboard) {
    const content = document.getElementById('leaderboardContent');
    
    if (leaderboard.length === 0) {
        content.innerHTML = '<div class="empty-state">暂无数据</div>';
        return;
    }
    
    content.innerHTML = leaderboard.map((item, index) => {
        let rankClass = 'normal';
        if (index === 0) rankClass = 'gold';
        else if (index === 1) rankClass = 'silver';
        else if (index === 2) rankClass = 'bronze';
        
        const isSelf = item.userId === currentUser.id;
        
        return `
            <div class="leaderboard-item ${isSelf ? 'self' : ''}">
                <div class="leaderboard-rank ${rankClass}">${index + 1}</div>
                <div class="leaderboard-avatar">${item.avatar}</div>
                <div class="leaderboard-info">
                    <div class="leaderboard-name">${item.nickname}${isSelf ? ' (我)' : ''}</div>
                    <div class="leaderboard-time">${formatHours(item.studyTime)}</div>
                </div>
            </div>
        `;
    }).join('');
}

function switchSidebarTab(tab) {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');

    document.getElementById('leaderboardTab').classList.add('hidden');
    document.getElementById('tasksTab').classList.add('hidden');
    document.getElementById('membersTab').classList.add('hidden');
    document.getElementById('emojiTab').classList.add('hidden');
    document.getElementById('chatTab').classList.add('hidden');

    document.getElementById(`${tab}Tab`).classList.remove('hidden');
    
    if (tab === 'leaderboard') {
        loadLeaderboard();
    } else if (tab === 'tasks') {
        loadTasks();
    } else if (tab === 'emoji') {
        initEmojiPanel();
    }
}

init();
