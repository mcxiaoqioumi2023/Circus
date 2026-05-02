const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const https = require('https');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const READ_FILE = path.join(DATA_DIR, 'lastread.json');
const EMOJIS_FILE = path.join(DATA_DIR, 'emojis.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ========== 数据层：纯 JSON 文件 ==========
function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {}
  return fallback;
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

let users = readJSON(USERS_FILE, {});
let contacts = readJSON(CONTACTS_FILE, {});
let groups = readJSON(GROUPS_FILE, [{ id: 'public', name: '大厅', announcement: '' }]);
let messages = readJSON(MESSAGES_FILE, {});
let lastRead = readJSON(READ_FILE, {});
let emojis = readJSON(EMOJIS_FILE, {});

// 默认管理员
if (!users['帕姆尼']) users['帕姆尼'] = { password: 'pomin123', nickname: '帕姆尼', avatar: '', signature: '管理员', uid: 1 };
if (!users['凯恩']) users['凯恩'] = { password: 'harmony123', nickname: '凯恩', avatar: '', signature: '管理员', uid: 2 };
let nextUid = Math.max(...Object.values(users).map(u => u.uid || 0), 0) + 1;

// 持久化定时器（每10秒保存一次，避免频繁写盘）
setInterval(() => {
  writeJSON(USERS_FILE, users);
  writeJSON(CONTACTS_FILE, contacts);
  writeJSON(GROUPS_FILE, groups);
  writeJSON(MESSAGES_FILE, messages);
  writeJSON(READ_FILE, lastRead);
  writeJSON(EMOJIS_FILE, emojis);
}, 10000);

// ========== 天气模块 ==========
const cityCodeMap = {
  "北京":"101010100","上海":"101020100","广州":"101280101","深圳":"101280601",
  "杭州":"101210101","成都":"101270101","重庆":"101040100","南京":"101190101",
  "武汉":"101200101","西安":"101110101","郑州":"101180101","济南":"101120101",
  "青岛":"101120201","大连":"101070201","厦门":"101230201","长沙":"101250101",
  "邢台":"101090901","石家庄":"101090101","邯郸":"101091001"
};

function getWeatherCode(city) {
  return cityCodeMap[city] || null;
}

function fetchWeather(cityCode) {
  return new Promise((resolve, reject) => {
    const url = `https://d1.weather.com.cn/sk_2d/${cityCode}.html`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const jsonStr = raw.replace('var dataSK=', '').replace(';', '');
          const data = JSON.parse(jsonStr);
          resolve({
            city: data.cityname,
            temp: data.temp,
            feeltemp: data.feeltemp,
            humidity: data.sd,
            wind: data.wd + ' ' + data.ws,
            aqi: data.aqi,
            aqiLevel: data.aqiLevel,
            time: data.time
          });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// 获取客户端IP定位 -> 城市 -> 天气
async function getClientWeather(ip) {
  try {
    const locData = await new Promise((resolve, reject) => {
      https.get(`https://ipapi.co/${ip}/json/`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const city = locData.city;
    if (!city) return null;
    const code = getWeatherCode(city);
    if (!code) return null;
    return await fetchWeather(code);
  } catch (e) {
    return null;
  }
}

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

// ========== WebSocket 内核 ==========
const wss = new WebSocketServer({ server });
const online = new Map(); // username -> ws

wss.on('connection', (ws, req) => {
  let username = null;
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || ws._socket.remoteAddress;

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
      ws.send(JSON.stringify({ type: 'registerSuccess' }));
    }
    // 登录
    else if (msg.type === 'login') {
      const u = users[msg.username];
      if (!u || u.password !== msg.password) {
        ws.send(JSON.stringify({ type: 'error', msg: '用户名或密码错误' }));
        return;
      }
      username = msg.username;
      online.set(username, ws);
      ws.send(JSON.stringify({
        type: 'loginSuccess',
        user: { uid: u.uid, username, nickname: u.nickname, avatar: u.avatar || '', signature: u.signature || '' }
      }));
      sendContacts(ws);
      ws.send(JSON.stringify({ type: 'groups', groups }));
      sendHistory(ws, 'public');
      broadcastOnlineCount();
    }
    // 更新个人资料
    else if (msg.type === 'updateProfile') {
      if (!username) return;
      const u = users[username];
      if (msg.user.nickname !== undefined) u.nickname = msg.user.nickname;
      if (msg.user.signature !== undefined) u.signature = msg.user.signature || '';
      if (msg.user.avatar !== undefined) u.avatar = msg.user.avatar || '';
      broadcast({ type: 'userUpdate', user: { uid: u.uid, username, nickname: u.nickname, avatar: u.avatar, signature: u.signature } });
    }
    // 添加好友（双向）
    else if (msg.type === 'addFriend') {
      if (!username) return;
      const target = msg.target;
      let friendUsername = null;
      if (users[target]) friendUsername = target;
      else {
        const found = Object.entries(users).find(([, u]) => u.uid == target);
        if (found) friendUsername = found[0];
      }
      if (!friendUsername) { ws.send(JSON.stringify({ type: 'error', msg: '用户不存在' })); return; }
      if (friendUsername === username) { ws.send(JSON.stringify({ type: 'error', msg: '不能添加自己' })); return; }
      if (!contacts[username]) contacts[username] = [];
      if (!contacts[friendUsername]) contacts[friendUsername] = [];
      if (!contacts[username].includes(friendUsername)) contacts[username].push(friendUsername);
      if (!contacts[friendUsername].includes(username)) contacts[friendUsername].push(username);
      sendContacts(ws);
      const friendWs = online.get(friendUsername);
      if (friendWs) sendContacts(friendWs);
      ws.send(JSON.stringify({ type: 'success', msg: '好友添加成功' }));
    }
    // 创建群
    else if (msg.type === 'createGroup') {
      if (!username) return;
      const gid = Date.now().toString();
      groups.push({ id: gid, name: msg.groupName, announcement: '' });
      sendGroupsAll();
    }
    // 群公告
    else if (msg.type === 'updateAnnouncement') {
      const g = groups.find(g => g.id === msg.groupId);
      if (g) { g.announcement = msg.announcement; broadcast({ type: 'announcementUpdated', groupId: g.id, announcement: g.announcement }); }
    }
    // 发送消息
    else if (msg.type === 'message') {
      if (!username) return;
      const room = msg.room || 'public';
      const u = users[username];
      let msgType = 'text', imageData = null, audioData = null, videoData = null;
      if (msg.imageData) { msgType = 'image'; imageData = msg.imageData; }
      else if (msg.audioData) { msgType = 'audio'; audioData = msg.audioData; }
      else if (msg.videoData) { msgType = 'video'; videoData = msg.videoData; }

      // 敏感词过滤（简单）
      let filtered = msg.text || '';
      const badWords = ['傻逼', '操你妈', 'fuck', 'shit'];
      badWords.forEach(w => {
        const reg = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        filtered = filtered.replace(reg, '*'.repeat(w.length));
      });

      if (!messages[room]) messages[room] = [];
      const msgId = messages[room].length + 1;
      const fullMsg = {
        id: msgId, type: msgType, room, from: username, nickname: u.nickname,
        avatar: u.avatar || '', text: filtered, imageData, audioData, videoData,
        timestamp: Date.now()
      };
      messages[room].push(fullMsg);
      if (messages[room].length > 100) messages[room] = messages[room].slice(-100);
      broadcast(fullMsg);

      // @提醒
      if (msgType === 'text') {
        const ats = filtered.match(/@(\S+)/g);
        if (ats) {
          ats.forEach(at => {
            const target = online.get(at.slice(1));
            if (target) target.send(JSON.stringify({ type: 'notification', msg: `${u.nickname} @了你` }));
          });
        }
      }
    }
    // 获取历史消息
    else if (msg.type === 'getHistory') {
      sendHistory(ws, msg.room || 'public');
    }
    // 标记已读
    else if (msg.type === 'markRead') {
      if (!username) return;
      if (!lastRead[username]) lastRead[username] = {};
      lastRead[username][msg.room || 'public'] = (messages[msg.room || 'public']?.length || 0);
    }
    // 天气请求
    else if (msg.type === 'weather') {
      (async () => {
        const weather = await getClientWeather(clientIp);
        if (weather) {
          ws.send(JSON.stringify({ type: 'weather', data: weather }));
        } else {
          ws.send(JSON.stringify({ type: 'weather', error: true }));
        }
      })();
    }
    // 获取在线人数
    else if (msg.type === 'onlineCount') {
      broadcastOnlineCount();
    }
    // 表情
    else if (msg.type === 'uploadEmoji') {
      if (!username) return;
      if (!emojis[username]) emojis[username] = [];
      emojis[username].push({ url: msg.url, shortcut: msg.shortcut || '' });
      ws.send(JSON.stringify({ type: 'emojis', emojis: emojis[username] }));
    }
    else if (msg.type === 'getEmojis') {
      ws.send(JSON.stringify({ type: 'emojis', emojis: emojis[username] || [] }));
    }
  });

  ws.on('close', () => {
    if (username) online.delete(username);
    broadcastOnlineCount();
  });

  // 内部函数
  function sendContacts(ws) {
    const list = (contacts[username] || []).map(n => {
      const u = users[n];
      return u ? { uid: u.uid, username: n, nickname: u.nickname, avatar: u.avatar || '' } : null;
    }).filter(Boolean);
    ws.send(JSON.stringify({ type: 'contacts', contacts: list }));
  }
  function sendGroupsAll() { broadcast({ type: 'groups', groups }); }
  function sendHistory(ws, room) {
    ws.send(JSON.stringify({ type: 'history', room, messages: messages[room] || [] }));
  }
  function broadcastOnlineCount() { broadcast({ type: 'onlineCount', count: online.size }); }
});

function broadcast(data) {
  const raw = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(raw); });
}

server.listen(PORT, () => {
  console.log(`🚀 OrionChat 内核启动于端口 ${PORT}`);
});
