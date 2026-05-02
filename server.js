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

if (!users['帕姆尼']) users['帕姆尼'] = { password: 'pomin123', nickname: '帕姆尼', avatar: '', signature: '管理员', uid: 1 };
if (!users['凯恩']) users['凯恩'] = { password: 'harmony123', nickname: '凯恩', avatar: '', signature: '管理员', uid: 2 };
let nextUid = Math.max(...Object.values(users).map(u => u.uid || 0), 0) + 1;

setInterval(() => {
  writeJSON(USERS_FILE, users);
  writeJSON(CONTACTS_FILE, contacts);
  writeJSON(GROUPS_FILE, groups);
  writeJSON(MESSAGES_FILE, messages);
  writeJSON(READ_FILE, lastRead);
  writeJSON(EMOJIS_FILE, emojis);
}, 10000);

// ========== 天气模块（修复版） ==========
const cityCodeMap = {
  // 华北
  "北京":"101010100","天津":"101030100","石家庄":"101090101","太原":"101100101","呼和浩特":"101080101",
  // 东北
  "沈阳":"101070101","大连":"101070201","长春":"101060101","哈尔滨":"101050101",
  // 华东
  "上海":"101020100","南京":"101190101","杭州":"101210101","合肥":"101220101","福州":"101230101",
  "厦门":"101230201","南昌":"101240101","济南":"101120101","青岛":"101120201",
  // 中南
  "郑州":"101180101","武汉":"101200101","长沙":"101250101","广州":"101280101","深圳":"101280601",
  "南宁":"101300101","海口":"101310101",
  // 西南
  "重庆":"101040100","成都":"101270101","贵阳":"101260101","昆明":"101290101","拉萨":"101140101",
  // 西北
  "西安":"101110101","兰州":"101160101","西宁":"101150101","银川":"101170101","乌鲁木齐":"101130101",
  // 河北部分城市
  "邢台":"101090901","邯郸":"101091001","保定":"101090201","唐山":"101090501",
  // 其他常见
  "苏州":"101190401","无锡":"101190201","宁波":"101210401","温州":"101210701",
  "东莞":"101281601","佛山":"101280601","珠海":"101280701"
};

function getWeatherCode(city) {
  // 直接匹配
  if (cityCodeMap[city]) return cityCodeMap[city];
  // 省份兜底：如果城市名包含省的关键词，尝试用省会
  const provinceMap = {
    "北京":"北京","天津":"天津","上海":"上海","重庆":"重庆",
    "河北":"石家庄","山西":"太原","内蒙古":"呼和浩特",
    "辽宁":"沈阳","吉林":"长春","黑龙江":"哈尔滨",
    "江苏":"南京","浙江":"杭州","安徽":"合肥","福建":"福州","江西":"南昌","山东":"济南",
    "河南":"郑州","湖北":"武汉","湖南":"长沙","广东":"广州","广西":"南宁","海南":"海口",
    "四川":"成都","贵州":"贵阳","云南":"昆明","西藏":"拉萨",
    "陕西":"西安","甘肃":"兰州","青海":"西宁","宁夏":"银川","新疆":"乌鲁木齐"
  };
  // 检查city是否包含省份名
  for (const [province, capital] of Object.entries(provinceMap)) {
    if (city.includes(province)) {
      return cityCodeMap[capital] || null;
    }
  }
  return null;
}

function fetchWeather(cityCode) {
  return new Promise((resolve, reject) => {
    const url = `https://d1.weather.com.cn/sk_2d/${cityCode}.html`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
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

async function getClientWeather(ip) {
  try {
    // 使用 ip-api.com 免费接口，返回中文城市
    const locData = await new Promise((resolve, reject) => {
      https.get(`http://ip-api.com/json/${ip}?lang=zh-CN`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const city = locData.city;
    console.log('定位城市:', city);
    if (!city) return null;
    const code = getWeatherCode(city);
    console.log('天气编码:', code);
    if (!code) return null;
    return await fetchWeather(code);
  } catch (e) {
    console.error('天气获取失败:', e.message);
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
const online = new Map();

wss.on('connection', (ws, req) => {
  let username = null;
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || ws._socket.remoteAddress;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

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
    else if (msg.type === 'updateProfile') {
      if (!username) return;
      const u = users[username];
      if (msg.user.nickname !== undefined) u.nickname = msg.user.nickname;
      if (msg.user.signature !== undefined) u.signature = msg.user.signature || '';
      if (msg.user.avatar !== undefined) u.avatar = msg.user.avatar || '';
      broadcast({ type: 'userUpdate', user: { uid: u.uid, username, nickname: u.nickname, avatar: u.avatar, signature: u.signature } });
    }
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
    else if (msg.type === 'createGroup') {
      if (!username) return;
      const gid = Date.now().toString();
      groups.push({ id: gid, name: msg.groupName, announcement: '' });
      sendGroupsAll();
    }
    else if (msg.type === 'updateAnnouncement') {
      const g = groups.find(g => g.id === msg.groupId);
      if (g) { g.announcement = msg.announcement; broadcast({ type: 'announcementUpdated', groupId: g.id, announcement: g.announcement }); }
    }
    else if (msg.type === 'message') {
      if (!username) return;
      const room = msg.room || 'public';
      const u = users[username];
      let msgType = 'text', imageData = null, audioData = null, videoData = null;
      if (msg.imageData) { msgType = 'image'; imageData = msg.imageData; }
      else if (msg.audioData) { msgType = 'audio'; audioData = msg.audioData; }
      else if (msg.videoData) { msgType = 'video'; videoData = msg.videoData; }

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
    else if (msg.type === 'getHistory') {
      sendHistory(ws, msg.room || 'public');
    }
    else if (msg.type === 'markRead') {
      if (!username) return;
      if (!lastRead[username]) lastRead[username] = {};
      lastRead[username][msg.room || 'public'] = (messages[msg.room || 'public']?.length || 0);
    }
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
    else if (msg.type === 'onlineCount') {
      broadcastOnlineCount();
    }
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
