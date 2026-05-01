const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 8080;

// ========== 初始化 SQLite 数据库 ==========
const db = new Database('circus.db');

// 创建表（如果不存在）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    signature TEXT DEFAULT ''
  );
  
  CREATE TABLE IF NOT EXISTS contacts (
    username TEXT NOT NULL,
    friend TEXT NOT NULL,
    PRIMARY KEY (username, friend)
  );
  
  CREATE TABLE IF NOT EXISTS groups_list (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (group_id, username)
  );
  
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    msg_type TEXT DEFAULT 'text',
    sender TEXT NOT NULL,
    nickname TEXT NOT NULL,
    text TEXT DEFAULT '',
    image_data TEXT DEFAULT NULL,
    audio_data TEXT DEFAULT NULL,
    timestamp INTEGER NOT NULL
  );
`);

// 插入默认管理员账号（如果不存在）
const insertAdmin = db.prepare(`
  INSERT OR IGNORE INTO users (username, password, nickname, signature)
  VALUES (?, ?, ?, ?)
`);
insertAdmin.run('帕姆尼', 'pomin123', '帕姆尼', '马戏团管理员');
insertAdmin.run('凯恩', 'harmony123', '凯恩', '马戏团管理员');

// 确保默认大厅群组存在
const defaultGroup = db.prepare(`SELECT COUNT(*) as cnt FROM groups_list WHERE id = 'public'`).get();
if (defaultGroup.cnt === 0) {
  db.prepare(`INSERT INTO groups_list (id, name) VALUES ('public', '大厅')`).run();
}

console.log('✅ SQLite 数据库初始化完成');

// ========== 静态文件服务 ==========
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

// ========== WebSocket 服务 ==========
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('✅ 新用户连接');
  let currentUsername = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
      console.log('📩 收到消息:', msg.type, '来自:', currentUsername);
    } catch (e) {
      return;
    }

    // ========== 注册 ==========
    if (msg.type === 'register') {
      const existing = db.prepare(`SELECT username FROM users WHERE username = ?`).get(msg.username);
      if (existing) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户名已存在' }));
      } else {
        db.prepare(`INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)`).run(
          msg.username,
          msg.password,
          msg.username
        );
        ws.send(JSON.stringify({ type: 'registerSuccess' }));
        console.log(`📝 新用户注册: ${msg.username}`);
      }
    }

    // ========== 登录 ==========
    else if (msg.type === 'login') {
      const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(msg.username);
      if (!user || user.password !== msg.password) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户名或密码错误' }));
      } else {
        currentUsername = msg.username;
        ws.send(JSON.stringify({
          type: 'loginSuccess',
          user: {
            username: user.username,
            nickname: user.nickname,
            avatar: user.avatar || '',
            signature: user.signature || ''
          }
        }));
        sendContacts(ws);
        sendGroups(ws);
        sendHistory(ws, 'public');
        console.log(`🔑 用户登录: ${currentUsername}`);
      }
    }

    // ========== 更新个人资料 ==========
    else if (msg.type === 'updateProfile') {
      if (!currentUsername) return;
      const u = msg.user;
      db.prepare(`UPDATE users SET nickname = ?, signature = ?, avatar = ? WHERE username = ?`).run(
        u.nickname || currentUsername,
        u.signature || '',
        u.avatar || '',
        currentUsername
      );
      const updated = db.prepare(`SELECT * FROM users WHERE username = ?`).get(currentUsername);
      broadcast({
        type: 'userUpdate',
        user: {
          username: updated.username,
          nickname: updated.nickname,
          avatar: updated.avatar || '',
          signature: updated.signature || ''
        }
      });
    }

    // ========== 添加好友 ==========
    else if (msg.type === 'addFriend') {
      if (!currentUsername) return;
      const target = msg.target;
      const friend = db.prepare(`SELECT username FROM users WHERE username = ?`).get(target);
      if (!friend) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户不存在' }));
        return;
      }
      const existing = db.prepare(`SELECT COUNT(*) as cnt FROM contacts WHERE username = ? AND friend = ?`).get(currentUsername, target);
      if (existing.cnt === 0) {
        db.prepare(`INSERT INTO contacts (username, friend) VALUES (?, ?)`).run(currentUsername, target);
      }
      sendContacts(ws);
    }

    // ========== 创建群聊 ==========
    else if (msg.type === 'createGroup') {
      if (!currentUsername) return;
      const groupId = Date.now().toString();
      db.prepare(`INSERT INTO groups_list (id, name) VALUES (?, ?)`).run(groupId, msg.groupName);
      db.prepare(`INSERT INTO group_members (group_id, username) VALUES (?, ?)`).run(groupId, currentUsername);
      sendGroupsAll();
    }

    // ========== ★ 发送消息 ★ ==========
    else if (msg.type === 'message') {
      if (!currentUsername) {
        ws.send(JSON.stringify({ type: 'error', msg: '请先登录' }));
        return;
      }

      const chatId = msg.chatId || 'public';
      const user = db.prepare(`SELECT nickname FROM users WHERE username = ?`).get(currentUsername);
      const nickname = user?.nickname || currentUsername;

      let msgType = 'text';
      let imageData = null;
      let audioData = null;

      if (msg.imageData) {
        msgType = 'image';
        imageData = msg.imageData;
      } else if (msg.audioData) {
        msgType = 'audio';
        audioData = msg.audioData;
      }

      const stmt = db.prepare(`INSERT INTO messages (chat_id, msg_type, sender, nickname, text, image_data, audio_data, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const result = stmt.run(chatId, msgType, currentUsername, nickname, msg.text || '', imageData, audioData, Date.now());

      const fullMessage = {
        type: 'message',
        chatId: chatId,
        msgType: msgType,
        from: currentUsername,
        nickname: nickname,
        text: msg.text || '',
        imageData: imageData,
        audioData: audioData,
        timestamp: Date.now(),
        id: result.lastInsertRowid
      };

      broadcast(fullMessage);
      console.log(`💬 消息 [${chatId}] ${currentUsername}: ${msg.text || `[${msgType}]`}`);
    }

    // ========== 获取历史消息 ==========
    else if (msg.type === 'getHistory') {
      sendHistory(ws, msg.chatId || 'public');
    }
  });

  ws.on('close', () => {
    console.log(`❌ 用户断开: ${currentUsername || '未登录'}`);
  });

  // ========== 辅助函数 ==========
  function sendContacts(ws) {
    const contacts = db.prepare(`SELECT friend FROM contacts WHERE username = ?`).all(currentUsername).map(row => {
      const u = db.prepare(`SELECT username, nickname, avatar FROM users WHERE username = ?`).get(row.friend);
      return {
        username: u.username,
        nickname: u.nickname || u.username,
        avatar: u.avatar || ''
      };
    });
    ws.send(JSON.stringify({ type: 'contacts', contacts }));
  }

  function sendGroups(ws) {
    const groups = db.prepare(`SELECT id, name FROM groups_list`).all();
    ws.send(JSON.stringify({ type: 'groups', groups }));
  }

  function sendGroupsAll() {
    const groups = db.prepare(`SELECT id, name FROM groups_list`).all();
    broadcast({ type: 'groups', groups });
  }

  function sendHistory(ws, chatId) {
    const messages = db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT 100`).all(chatId).map(row => ({
      type: 'message',
      chatId: row.chat_id,
      msgType: row.msg_type,
      from: row.sender,
      nickname: row.nickname,
      text: row.text,
      imageData: row.image_data,
      audioData: row.audio_data,
      timestamp: row.timestamp
    }));
    ws.send(JSON.stringify({ type: 'history', chatId, messages }));
  }
});

// ========== 全局广播 ==========
function broadcast(data) {
  const jsonData = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(jsonData);
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎪 马戏团服务器启动，端口：${PORT}`);
});
