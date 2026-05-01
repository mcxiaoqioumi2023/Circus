const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// ========== 数据文件路径 ==========
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const READ_FILE = path.join(DATA_DIR, 'lastread.json');
const EMOJIS_FILE = path.join(DATA_DIR, 'emojis.json');
const SENSITIVE_FILE = path.join(DATA_DIR, 'sensitive.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 读取 JSON 文件
function readJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return defaultValue;
}

// 写入 JSON 文件
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// 初始化数据
let users = readJSON(USERS_FILE, {});
let contacts = readJSON(CONTACTS_FILE, {});
let groups = readJSON(GROUPS_FILE, [{ id: 'public', name: '大厅', announcement: '' }]);
let messages = readJSON(MESSAGES_FILE, {});
let lastRead = readJSON(READ_FILE, {});
let emojis = readJSON(EMOJIS_FILE, {});
let sensitiveWords = readJSON(SENSITIVE_FILE, ['傻逼', '操你妈', 'fuck', 'shit']);

// 默认管理员
if (!users['帕姆尼']) users['帕姆尼'] = { password: 'pomin123', nickname: '帕姆尼', avatar: '', signature: '马戏团管理员', uid: 1 };
if (!users['凯恩']) users['凯恩'] = { password: 'harmony123', nickname: '凯恩', avatar: '', signature: '马戏团管理员', uid: 2 };
let nextUid = Object.values(users).reduce((max, u) => Math.max(max, u.uid || 0), 0) + 1;

// 保存用户数据到文件
function saveData() {
  writeJSON(USERS_FILE, users);
  writeJSON(CONTACTS_FILE, contacts);
  writeJSON(GROUPS_FILE, groups);
  writeJSON(MESSAGES_FILE, messages);
  writeJSON(READ_FILE, lastRead);
  writeJSON(EMOJIS_FILE, emojis);
}

// 定期保存
setInterval(saveData, 5000);

// ========== 静态文件服务 ==========
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end();
  }
});

// ========== WebSocket ==========
const wss = new WebSocket.Server({ server });
const onlineUsers = new Map();

wss.on('connection', (ws) => {
  let currentUsername = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // 注册
    if (msg.type === 'register') {
      if (users[msg.username]) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户名已存在' }));
        return;
      }
      users[msg.username] = {
        password: msg.password,
        nickname: msg.username,
        avatar: '',
        signature: '',
        uid: nextUid++
      };
      saveData();
      ws.send(JSON.stringify({ type: 'registerSuccess' }));
    }
    // 登录
    else if (msg.type === 'login') {
      const user = users[msg.username];
      if (!user || user.password !== msg.password) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户名或密码错误' }));
        return;
      }
      currentUsername = msg.username;
      onlineUsers.set(currentUsername, ws);
      ws.send(JSON.stringify({
        type: 'loginSuccess',
        user: {
          uid: user.uid,
          username: msg.username,
          nickname: user.nickname,
          avatar: user.avatar || '',
          signature: user.signature || ''
        }
      }));
      sendContacts(ws);
      ws.send(JSON.stringify({ type: 'groups', groups }));
      sendHistory(ws, 'public');
      broadcastOnlineCount();
    }
    // 更新个人资料
    else if (msg.type === 'updateProfile') {
      if (!currentUsername) return;
      const { nickname, signature, avatar } = msg.user;
      const u = users[currentUsername];
      if (nickname !== undefined) u.nickname = nickname;
      if (signature !== undefined) u.signature = signature || '';
      if (avatar !== undefined) u.avatar = avatar || '';
      saveData();
      broadcast({ type: 'userUpdate', user: { uid: u.uid, username: currentUsername, nickname: u.nickname, avatar: u.avatar, signature: u.signature } });
    }
    // 添加好友（支持用户名或UID）
    else if (msg.type === 'addFriend') {
      if (!currentUsername) return;
      const { target } = msg;
      let friendUsername = null;
      if (users[target]) {
        friendUsername = target;
      } else {
        const byUid = Object.entries(users).find(([, u]) => u.uid == target);
        if (byUid) friendUsername = byUid[0];
      }
      if (!friendUsername) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户不存在' }));
        return;
      }
      if (friendUsername === currentUsername) {
        ws.send(JSON.stringify({ type: 'error', msg: '不能添加自己' }));
        return;
      }
      if (!contacts[currentUsername]) contacts[currentUsername] = [];
      if (!contacts[friendUsername]) contacts[friendUsername] = [];
      if (!contacts[currentUsername].includes(friendUsername)) {
        contacts[currentUsername].push(friendUsername);
        contacts[friendUsername].push(currentUsername);
        saveData();
      }
      sendContacts(ws);
      const friendWs = onlineUsers.get(friendUsername);
      if (friendWs) sendContacts(friendWs);
      ws.send(JSON.stringify({ type: 'success', msg: '添加成功' }));
    }
    // 创建群聊
    else if (msg.type === 'createGroup') {
      if (!currentUsername) return;
      const groupId = Date.now().toString();
      groups.push({ id: groupId, name: msg.groupName, announcement: '' });
      saveData();
      sendGroupsAll();
    }
    // 加入群聊（通过群ID）
    else if (msg.type === 'joinGroup') {
      if (!currentUsername) return;
      const { groupId } = msg;
      const exists = groups.find(g => g.id === groupId);
      if (!exists) {
        ws.send(JSON.stringify({ type: 'error', msg: '群不存在' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'success', msg: '已加入群聊' }));
      sendGroups(ws);
    }
    // 群公告
    else if (msg.type === 'updateAnnouncement') {
      const { groupId, announcement } = msg;
      const group = groups.find(g => g.id === groupId);
      if (group) {
        group.announcement = announcement;
        saveData();
        broadcast({ type: 'announcementUpdated', groupId, announcement });
      }
    }
    // 发送消息
    else if (msg.type === 'message') {
      if (!currentUsername) return;
      const chatId = msg.chatId || 'public';
      const user = users[currentUsername];
      const nickname = user.nickname;
      const avatar = user.avatar || '';
      let msgType = 'text', imageData = null, audioData = null, videoData = null;
      if (msg.imageData) { msgType = 'image'; imageData = msg.imageData; }
      else if (msg.audioData) { msgType = 'audio'; audioData = msg.audioData; }
      else if (msg.videoData) { msgType = 'video'; videoData = msg.videoData; }

      // 敏感词过滤（仅文本）
      let filteredText = msg.text || '';
      if (msgType === 'text') {
        for (const word of sensitiveWords) {
          const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escaped, 'gi');
          filteredText = filteredText.replace(regex, '*'.repeat(word.length));
        }
      }

      if (!messages[chatId]) messages[chatId] = [];
      const msgId = messages[chatId].length + 1;
      const fullMsg = {
        id: msgId,
        chatId,
        msgType,
        from: currentUsername,
        nickname,
        avatar,
        text: filteredText,
        imageData,
        audioData,
        videoData,
        timestamp: Date.now()
      };
      messages[chatId].push(fullMsg);
      saveData();

      broadcast(fullMsg);

      // @提醒处理
      if (msgType === 'text') {
        const atMatches = filteredText.match(/@(\S+)/g);
        if (atMatches) {
          atMatches.forEach(at => {
            const targetName = at.slice(1);
            const targetWs = onlineUsers.get(targetName);
            if (targetWs) {
              targetWs.send(JSON.stringify({
                type: 'notification',
                msg: `${nickname} 在聊天中@了你`,
                chatId
              }));
            }
          });
        }
      }
    }
    // 获取历史消息
    else if (msg.type === 'getHistory') {
      sendHistory(ws, msg.chatId || 'public');
    }
    // 标记已读
    else if (msg.type === 'markRead') {
      if (!currentUsername) return;
      const { chatId, lastMsgId } = msg;
      if (!lastRead[currentUsername]) lastRead[currentUsername] = {};
      if (!lastRead[currentUsername][chatId] || lastRead[currentUsername][chatId] < lastMsgId) {
        lastRead[currentUsername][chatId] = lastMsgId;
        saveData();
      }
    }
    // 表情包
    else if (msg.type === 'addEmoji') {
      if (!currentUsername) return;
      if (!emojis[currentUsername]) emojis[currentUsername] = [];
      emojis[currentUsername].push({ url: msg.url, shortcut: msg.shortcut || '' });
      saveData();
      ws.send(JSON.stringify({ type: 'emojiAdded', url: msg.url, shortcut: msg.shortcut }));
    }
    else if (msg.type === 'getEmojis') {
      const myEmojis = emojis[currentUsername] || [];
      ws.send(JSON.stringify({ type: 'emojis', emojis: myEmojis }));
    }

    ws.on('close', () => {
      if (currentUsername) onlineUsers.delete(currentUsername);
      broadcastOnlineCount();
    });

    // 内部函数
    function sendContacts(ws) {
      const myContacts = (contacts[currentUsername] || []).map(username => {
        const u = users[username];
        if (!u) return null;
        return { uid: u.uid, username, nickname: u.nickname, avatar: u.avatar || '' };
      }).filter(Boolean);
      ws.send(JSON.stringify({ type: 'contacts', contacts: myContacts }));
    }

    function sendGroups(ws) {
      ws.send(JSON.stringify({ type: 'groups', groups }));
    }

    function sendGroupsAll() {
      broadcast({ type: 'groups', groups });
    }

    function sendHistory(ws, chatId) {
      const msgs = messages[chatId] || [];
      ws.send(JSON.stringify({ type: 'history', chatId, messages: msgs }));
    }

    function broadcastOnlineCount() {
      broadcast({ type: 'onlineCount', count: onlineUsers.size });
    }
  });
});

function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(json);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎪 马戏团服务器启动：${PORT}`);
});
