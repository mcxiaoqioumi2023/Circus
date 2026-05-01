const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// 静态文件服务
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

// WebSocket 服务
const wss = new WebSocket.Server({ server });

const users = {
  '帕姆尼': { password: 'pomin123', nickname: '帕姆尼', avatar: '', signature: '马戏团管理员' },
  '凯恩':   { password: 'harmony123', nickname: '凯恩', avatar: '', signature: '马戏团管理员' }
};
const contacts = {};
const groups = [{ id: 'public', name: '大厅', members: [] }];
const messages = {};

wss.on('connection', (ws) => {
  console.log('✅ 新用户连接');
  let currentUsername = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    // 注册
    if (msg.type === 'register') {
      if (users[msg.username]) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户名已存在' }));
      } else {
        users[msg.username] = {
          password: msg.password,
          nickname: msg.username,
          avatar: '',
          signature: ''
        };
        ws.send(JSON.stringify({ type: 'registerSuccess' }));
      }
    }
    // 登录
    else if (msg.type === 'login') {
      const user = users[msg.username];
      if (!user || user.password !== msg.password) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户名或密码错误' }));
      } else {
        currentUsername = msg.username;
        ws.send(JSON.stringify({
          type: 'loginSuccess',
          user: {
            username: msg.username,
            nickname: user.nickname,
            avatar: user.avatar,
            signature: user.signature
          }
        }));
        // 发好友列表
        const list = (contacts[currentUsername] || []).map(u => ({
          username: u,
          nickname: users[u]?.nickname || u,
          avatar: users[u]?.avatar || ''
        }));
        ws.send(JSON.stringify({ type: 'contacts', contacts: list }));
        ws.send(JSON.stringify({ type: 'groups', groups }));
      }
    }
    // 更新个人资料
    else if (msg.type === 'updateProfile') {
      if (!currentUsername) return;
      const u = users[currentUsername];
      if (!u) return;
      u.nickname = msg.user.nickname || u.nickname;
      u.signature = msg.user.signature || u.signature;
      u.avatar = msg.user.avatar || u.avatar;
      broadcast({
        type: 'userUpdate',
        user: { username: currentUsername, ...u }
      });
    }
    // 添加好友
    else if (msg.type === 'addFriend') {
      if (!currentUsername || !users[msg.target]) return;
      if (!contacts[currentUsername]) contacts[currentUsername] = [];
      if (!contacts[currentUsername].includes(msg.target)) {
        contacts[currentUsername].push(msg.target);
        const list = (contacts[currentUsername] || []).map(u => ({
          username: u,
          nickname: users[u]?.nickname || u,
          avatar: users[u]?.avatar || ''
        }));
        ws.send(JSON.stringify({ type: 'contacts', contacts: list }));
      }
    }
    // 创建群聊
    else if (msg.type === 'createGroup') {
      if (!currentUsername) return;
      const newGroup = {
        id: Date.now().toString(),
        name: msg.groupName,
        members: [currentUsername]
      };
      groups.push(newGroup);
      broadcast({ type: 'groups', groups });
    }
    // 消息
    else if (msg.type === 'message') {
      const chatId = msg.chatId || 'public';
      if (!messages[chatId]) messages[chatId] = [];
      const full = {
        type: 'message',
        chatId,
        from: currentUsername,
        nickname: users[currentUsername]?.nickname || currentUsername,
        text: msg.text || '',
        imageData: msg.imageData || null,
        audioData: msg.audioData || null
      };
      messages[chatId].push(full);
      broadcast(full);
    }
  });

  ws.on('close', () => {
    console.log('❌ 用户断开');
  });
});

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

server.listen(PORT, () => {
  console.log(`🎪 马戏团服务器启动，端口：${PORT}`);
});
