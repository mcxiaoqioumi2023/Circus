const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const initSqlJs = require('sql.js');

const PORT = process.env.PORT || 8080;
let db;

// ========== 初始化数据库 ==========
async function startServer() {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, 'circus.db');

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 用户表（新加 uid 自增、avatar 默认空）
  db.run(`CREATE TABLE IF NOT EXISTS users (
    uid INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    signature TEXT DEFAULT ''
  )`);
  // 好友表（双向，插入两条）
  db.run(`CREATE TABLE IF NOT EXISTS contacts (
    username TEXT NOT NULL,
    friend TEXT NOT NULL,
    PRIMARY KEY (username, friend)
  )`);
  // 群组表
  db.run(`CREATE TABLE IF NOT EXISTS groups_list (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    announcement TEXT DEFAULT ''
  )`);
  // 群成员表
  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (group_id, username)
  )`);
  // 消息表（增加视频类型）
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    msg_type TEXT DEFAULT 'text',
    sender TEXT NOT NULL,
    nickname TEXT NOT NULL,
    text TEXT DEFAULT '',
    image_data TEXT DEFAULT NULL,
    audio_data TEXT DEFAULT NULL,
    video_data TEXT DEFAULT NULL,
    timestamp INTEGER NOT NULL
  )`);
  // 已读状态表：记录用户在每个聊天室最后已读的消息ID
  db.run(`CREATE TABLE IF NOT EXISTS last_read (
    username TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    last_msg_id INTEGER NOT NULL,
    PRIMARY KEY (username, chat_id)
  )`);
  // 自定义表情表
  db.run(`CREATE TABLE IF NOT EXISTS emojis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    url TEXT NOT NULL,
    shortcut TEXT NOT NULL
  )`);
  // 敏感词表
  db.run(`CREATE TABLE IF NOT EXISTS sensitive_words (
    word TEXT PRIMARY KEY
  )`);

  // 默认敏感词
  const defaultWords = ['傻逼', '操你妈', 'fuck', 'shit'];
  const insertWord = db.prepare(`INSERT OR IGNORE INTO sensitive_words (word) VALUES (?)`);
  defaultWords.forEach(w => insertWord.run(w));

  // 插入默认管理员（带 UID）
  const insertAdmin = db.prepare(`INSERT OR IGNORE INTO users (username, password, nickname, avatar, signature) VALUES (?,?,?,?,?)`);
  insertAdmin.run('帕姆尼', 'pomin123', '帕姆尼', '', '马戏团管理员');
  insertAdmin.run('凯恩', 'harmony123', '凯恩', '', '马戏团管理员');
  // 默认大厅
  db.run(`INSERT OR IGNORE INTO groups_list (id, name) VALUES ('public','大厅')`);

  // 每5秒保存数据库
  function saveDb() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
  setInterval(saveDb, 5000);

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

  // 在线用户的 WebSocket 连接映射 (username -> ws)
  const onlineUsers = new Map();

  wss.on('connection', (ws) => {
    let currentUsername = null;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      // ========== 注册 ==========
      if (msg.type === 'register') {
        const exists = db.exec(`SELECT username FROM users WHERE username = ?`, [msg.username]);
        if (exists.length && exists[0].values.length) {
          ws.send(JSON.stringify({ type: 'error', msg: '用户名已存在' }));
        } else {
          db.run(`INSERT INTO users (username, password, nickname) VALUES (?,?,?)`, [msg.username, msg.password, msg.username]);
          ws.send(JSON.stringify({ type: 'registerSuccess' }));
        }
      }
      // ========== 登录 ==========
      else if (msg.type === 'login') {
        const rows = db.exec(`SELECT * FROM users WHERE username = ? AND password = ?`, [msg.username, msg.password]);
        if (!rows.length || !rows[0].values.length) {
          ws.send(JSON.stringify({ type: 'error', msg: '用户名或密码错误' }));
          return;
        }
        const u = rows[0].values[0];
        currentUsername = u[1]; // username
        onlineUsers.set(currentUsername, ws);
        ws.send(JSON.stringify({
          type: 'loginSuccess',
          user: {
            uid: u[0],
            username: u[1],
            nickname: u[3],
            avatar: u[4] || '',
            signature: u[5] || ''
          }
        }));
        sendContacts(ws);
        sendGroups(ws);
        sendHistory(ws, 'public');
        broadcastOnlineCount();
      }
      // ========== 更新个人资料 ==========
      else if (msg.type === 'updateProfile') {
        if (!currentUsername) return;
        const { nickname, signature, avatar } = msg.user;
        db.run(`UPDATE users SET nickname=?, signature=?, avatar=? WHERE username=?`, [nickname, signature || '', avatar || '', currentUsername]);
        const u = db.exec(`SELECT * FROM users WHERE username=?`, [currentUsername])[0].values[0];
        broadcast({
          type: 'userUpdate',
          user: { uid: u[0], username: u[1], nickname: u[3], avatar: u[4] || '', signature: u[5] || '' }
        });
      }
      // ========== 通过 UID 或用户名添加好友 (双向) ==========
      else if (msg.type === 'addFriend') {
        if (!currentUsername) return;
        const { target } = msg; // 可能是 username 或 uid
        let friendUsername;
        const byUsername = db.exec(`SELECT username FROM users WHERE username = ?`, [target]);
        if (byUsername.length && byUsername[0].values.length) {
          friendUsername = target;
        } else {
          const byUid = db.exec(`SELECT username FROM users WHERE uid = ?`, [parseInt(target)]);
          if (byUid.length && byUid[0].values.length) {
            friendUsername = byUid[0].values[0][0];
          }
        }
        if (!friendUsername) {
          ws.send(JSON.stringify({ type: 'error', msg: '用户不存在' }));
          return;
        }
        if (friendUsername === currentUsername) {
          ws.send(JSON.stringify({ type: 'error', msg: '不能添加自己' }));
          return;
        }
        // 双向插入
        db.run(`INSERT OR IGNORE INTO contacts (username, friend) VALUES (?,?)`, [currentUsername, friendUsername]);
        db.run(`INSERT OR IGNORE INTO contacts (username, friend) VALUES (?,?)`, [friendUsername, currentUsername]);
        // 刷新自己的联系人列表
        sendContacts(ws);
        // 通知对方刷新
        const friendWs = onlineUsers.get(friendUsername);
        if (friendWs) {
          sendContacts(friendWs);
        }
        ws.send(JSON.stringify({ type: 'success', msg: '添加成功' }));
      }
      // ========== 创建群聊 ==========
      else if (msg.type === 'createGroup') {
        if (!currentUsername) return;
        const groupId = Date.now().toString();
        db.run(`INSERT INTO groups_list (id, name) VALUES (?,?)`, [groupId, msg.groupName]);
        db.run(`INSERT INTO group_members (group_id, username) VALUES (?,?)`, [groupId, currentUsername]);
        sendGroupsAll();
      }
      // ========== 加入群聊 (通过群ID) ==========
      else if (msg.type === 'joinGroup') {
        if (!currentUsername) return;
        const { groupId } = msg;
        const exists = db.exec(`SELECT id FROM groups_list WHERE id = ?`, [groupId]);
        if (!exists.length || !exists[0].values.length) {
          ws.send(JSON.stringify({ type: 'error', msg: '群不存在' }));
          return;
        }
        db.run(`INSERT OR IGNORE INTO group_members (group_id, username) VALUES (?,?)`, [groupId, currentUsername]);
        ws.send(JSON.stringify({ type: 'success', msg: '已加入群聊' }));
        sendGroups(ws);
      }
      // ========== 群公告 ==========
      else if (msg.type === 'updateAnnouncement') {
        const { groupId, announcement } = msg;
        db.run(`UPDATE groups_list SET announcement=? WHERE id=?`, [announcement, groupId]);
        broadcast({ type: 'announcementUpdated', groupId, announcement });
      }
      // ========== ★ 发送消息 ★ ==========
      else if (msg.type === 'message') {
        if (!currentUsername) return;
        const chatId = msg.chatId || 'public';
        const userRow = db.exec(`SELECT uid, nickname, avatar FROM users WHERE username=?`, [currentUsername]);
        const user = userRow[0].values[0];
        const nickname = user[1];
        const avatar = user[2] || '';
        let msgType = 'text';
        let imageData = null, audioData = null, videoData = null;
        if (msg.imageData) { msgType = 'image'; imageData = msg.imageData; }
        else if (msg.audioData) { msgType = 'audio'; audioData = msg.audioData; }
        else if (msg.videoData) { msgType = 'video'; videoData = msg.videoData; }

        // 敏感词过滤（仅文本消息）
        let filteredText = msg.text || '';
        if (msgType === 'text') {
          const words = db.exec(`SELECT word FROM sensitive_words`);
          if (words.length) {
            const sensitiveList = words[0].values.map(r => r[0]);
            for (const word of sensitiveList) {
              const reg = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
              filteredText = filteredText.replace(reg, '*'.repeat(word.length));
            }
          }
        }

        const stmt = db.prepare(`INSERT INTO messages (chat_id, msg_type, sender, nickname, text, image_data, audio_data, video_data, timestamp) VALUES (?,?,?,?,?,?,?,?,?)`);
        const result = stmt.run(chatId, msgType, currentUsername, nickname, filteredText, imageData, audioData, videoData, Date.now());
        const msgId = result.lastInsertRowid;

        const fullMsg = {
          type: 'message',
          chatId,
          msgId,
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
        // @提醒处理（文本中包含 @用户名 ）
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

        broadcast(fullMsg);
      }
      // ========== 获取历史消息 ==========
      else if (msg.type === 'getHistory') {
        sendHistory(ws, msg.chatId || 'public');
      }
      // ========== 标记已读 ==========
      else if (msg.type === 'markRead') {
        if (!currentUsername) return;
        const chatId = msg.chatId;
        const lastMsgId = msg.lastMsgId;
        const existing = db.exec(`SELECT last_msg_id FROM last_read WHERE username=? AND chat_id=?`, [currentUsername, chatId]);
        if (existing.length && existing[0].values.length) {
          const currentMax = existing[0].values[0][0];
          if (lastMsgId > currentMax) {
            db.run(`UPDATE last_read SET last_msg_id=? WHERE username=? AND chat_id=?`, [lastMsgId, currentUsername, chatId]);
          }
        } else {
          db.run(`INSERT INTO last_read (username, chat_id, last_msg_id) VALUES (?,?,?)`, [currentUsername, chatId, lastMsgId]);
        }
      }
      // ========== 获取未读计数 ==========
      else if (msg.type === 'getUnreadCount') {
        sendUnreadCount(ws, currentUsername);
      }
      // ========== 自定义表情 ==========
      else if (msg.type === 'addEmoji') {
        if (!currentUsername) return;
        db.run(`INSERT INTO emojis (username, url, shortcut) VALUES (?,?,?)`, [currentUsername, msg.url, msg.shortcut]);
        ws.send(JSON.stringify({ type: 'emojiAdded', url: msg.url, shortcut: msg.shortcut }));
      }
      else if (msg.type === 'getEmojis') {
        const rows = db.exec(`SELECT id, url, shortcut FROM emojis WHERE username=?`, [currentUsername || '']);
        const emojis = rows.length ? rows[0].values.map(r => ({ id: r[0], url: r[1], shortcut: r[2] })) : [];
        ws.send(JSON.stringify({ type: 'emojis', emojis }));
      }
    });

    ws.on('close', () => {
      if (currentUsername) onlineUsers.delete(currentUsername);
      broadcastOnlineCount();
    });

    // ---------- 内部辅助函数 ----------
    function sendContacts(ws) {
      const rows = db.exec(`SELECT friend FROM contacts WHERE username=?`, [currentUsername]);
      const contacts = [];
      if (rows.length) {
        rows[0].values.forEach(row => {
          const u = db.exec(`SELECT uid, username, nickname, avatar FROM users WHERE username=?`, [row[0]]);
          if (u.length && u[0].values.length) {
            const val = u[0].values[0];
            contacts.push({ uid: val[0], username: val[1], nickname: val[2], avatar: val[3] || '' });
          }
        });
      }
      ws.send(JSON.stringify({ type: 'contacts', contacts }));
    }

    function sendGroups(ws) {
      const rows = db.exec(`SELECT id, name, announcement FROM groups_list`);
      const groups = rows.length ? rows[0].values.map(r => ({
        id: r[0],
        name: r[1],
        announcement: r[2]
      })) : [{ id: 'public', name: '大厅', announcement: '' }];
      ws.send(JSON.stringify({ type: 'groups', groups }));
    }

    function sendGroupsAll() {
      const rows = db.exec(`SELECT id, name, announcement FROM groups_list`);
      const groups = rows.length ? rows[0].values.map(r => ({
        id: r[0],
        name: r[1],
        announcement: r[2]
      })) : [{ id: 'public', name: '大厅', announcement: '' }];
      broadcast({ type: 'groups', groups });
    }

    function sendHistory(ws, chatId) {
      const rows = db.exec(`SELECT m.*, u.avatar FROM messages m JOIN users u ON m.sender = u.username WHERE m.chat_id=? ORDER BY m.timestamp ASC LIMIT 100`, [chatId]);
      const msgs = [];
      if (rows.length) {
        rows[0].values.forEach(r => {
          msgs.push({
            type: 'message',
            chatId: r[1],
            msgId: r[0],
            msgType: r[2],
            from: r[3],
            nickname: r[4],
            text: r[5],
            imageData: r[6],
            audioData: r[7],
            videoData: r[8],
            timestamp: r[9],
            avatar: r[10] || ''
          });
        });
      }
      ws.send(JSON.stringify({ type: 'history', chatId, messages: msgs }));
    }

    function sendUnreadCount(ws, username) {
      const groups = db.exec(`SELECT id FROM groups_list`);
      if (!groups.length) return;
      const groupIds = groups[0].values.map(r => r[0]);
      const unread = {};
      groupIds.forEach(gid => {
        const lastReadRow = db.exec(`SELECT last_msg_id FROM last_read WHERE username=? AND chat_id=?`, [username, gid]);
        let lastReadId = 0;
        if (lastReadRow.length && lastReadRow[0].values.length) {
          lastReadId = lastReadRow[0].values[0][0];
        }
        const countRow = db.exec(`SELECT COUNT(*) FROM messages WHERE chat_id=? AND id > ?`, [gid, lastReadId]);
        const count = countRow.length ? countRow[0].values[0][0] : 0;
        unread[gid] = count;
      });
      ws.send(JSON.stringify({ type: 'unreadCount', unread }));
    }

    function broadcastOnlineCount() {
      broadcast({ type: 'onlineCount', count: onlineUsers.size });
    }
  });

  function broadcast(data) {
    const json = JSON.stringify(data);
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(json);
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎪 服务器启动：${PORT}`);
  });
}

startServer().catch(err => console.error(err));
