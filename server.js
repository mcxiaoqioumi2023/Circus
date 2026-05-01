const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ------- 静态文件服务 -------
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ------- WebSocket -------
const wss = new WebSocket.Server({ server });

const users = {
  '帕姆尼': { password: 'pomin123', nickname: '帕姆尼', avatar: '', signature: '马戏团管理员' },
  '凯恩':   { password: 'harmony123', nickname: '凯恩', avatar: '', signature: '马戏团管理员' }
};

const contacts = {};
const groups = [{ id: 'public', name: '大厅', members: [] }];
const messages = {};

wss.on('connection', (ws) => {
  let currentUsername = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // 注册
    if (msg.type === 'register') {
      if (users[msg.username]) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户名已存在' }));
      } else {
        users[msg.username] = {
          password: msg.password, nickname: msg.username, avatar: '', signature: ''
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
          user: { username: msg.username, nickname: user.nickname, avatar: user.avatar, signature: user.signature }
        }));
        sendContacts(ws);
        ws.send(JSON.stringify({ type: 'groups', groups }));
      }
    }
    // 更新资料
    else if (msg.type === 'updateProfile') {
      if (!currentUsername) return;
      const u = users[currentUsername];
      if (!u) return;
      u.nickname = msg.user.nickname || u.nickname;
      u.signature = msg.user.signature || u.signature;
      u.avatar = msg.user.avatar || u.avatar;
      broadcast({ type: 'userUpdate', user: { username: currentUsername, ...u } });
    }
    // 添加好友
    else if (msg.type === 'addFriend') {
      if (!currentUsername || !users[msg.target]) return;
      if (!contacts[currentUsername]) contacts[currentUsername] = [];
      if (!contacts[currentUsername].includes(msg.target)) {
        contacts[currentUsername].push(msg.target);
        sendContacts(ws);
      }
    }
    // 创建群聊
    else if (msg.type === 'createGroup') {
      if (!currentUsername) return;
      const g = { id: Date.now().toString(), name: msg.groupName, members: [currentUsername] };
      groups.push(g);
      broadcast({ type: 'groups', groups });
    }
    // 消息
    else if (msg.type === 'message') {
      const chatId = msg.chatId || 'public';
      if (!messages[chatId]) messages[chatId] = [];
      const full = {
        type: 'message', chatId,
        from: currentUsername,
        nickname: users[currentUsername]?.nickname || currentUsername,
        text: msg.text || '',
        data: msg.imageData || msg.audioData || '',
        msgType: msg.imageData ? 'image' : (msg.audioData ? 'audio' : 'text')
      };
      messages[chatId].push(full);
      broadcast(full);
    }
  });

  function sendContacts(ws) {
    const list = (contacts[currentUsername] || []).map(u => ({
      username: u,
      nickname: users[u]?.nickname || u,
      avatar: users[u]?.avatar || ''
    }));
    ws.send(JSON.stringify({ type: 'contacts', contacts: list }));
  }

  function broadcast(data) {
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
    });
  }
});

server.listen(8080, () => {
  console.log('🎪 马戏团系统已启动 → http://localhost:8080');
});