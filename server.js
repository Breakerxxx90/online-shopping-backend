const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json'); // เพิ่มไฟล์หมวดหมู่

function initDataFile(file, defaultData) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
  }
}

// ข้อมูลเริ่มต้นสำหรับหมวดหมู่
initDataFile(CATEGORIES_FILE, [
  { key: 'foryou', name: 'สินค้าทั่วไป' },
  { key: 'trending', name: 'Trending' },
  { key: 'gamer', name: 'Gamer' }
]);

initDataFile(PRODUCTS_FILE, {
  foryou: [
    { id: 'kb1', category: 'foryou', name: 'Keybord Pro', price: 250.0, image: '', icon: '⌨️', desc: 'คีย์บอร์ดคุณภาพสูง' },
    { id: 'kb2', category: 'foryou', name: 'Keybord Lite', price: 250.0, image: '', icon: '⌨️', desc: 'คีย์บอร์ดรุ่นเบสิค' },
    { id: 'kb3', category: 'foryou', name: 'Keybord RGB', price: 250.0, image: '', icon: '⌨️', desc: 'คีย์บอร์ดไฟ RGB' },
    { id: 'kb4', category: 'foryou', name: 'Keybord Mini', price: 250.0, image: '', icon: '⌨️', desc: 'คีย์บอร์ดขนาดกะทัดรัด' }
  ],
  trending: [
    { id: 'sw1', category: 'trending', name: 'Smart Watch X', price: 299.9, image: '', icon: '⌚', desc: 'นาฬิกาอัจฉริยะรุ่นใหม่' },
    { id: 'sw2', category: 'trending', name: 'Smart Watch Pro', price: 299.9, image: '', icon: '⌚', desc: 'นาฬิกาอัจฉริยะพรีเมียม' },
    { id: 'sw3', category: 'trending', name: 'Smart Watch S', price: 299.9, image: '', icon: '⌚', desc: 'นาฬิกาอัจฉริยะสปอร์ต' },
    { id: 'sw4', category: 'trending', name: 'Smart Watch Fit', price: 299.9, image: '', icon: '⌚', desc: 'นาฬิกาอัจฉริยะเพื่อสุขภาพ' }
  ],
  gamer: [
    { id: 'ms1', category: 'gamer', name: 'Gaming Mouse X1', price: 25, image: '', icon: '🖱️', desc: 'เมาส์เกมมิ่งความแม่นยำสูง' },
    { id: 'ms2', category: 'gamer', name: 'Gaming Mouse Pro', price: 25, image: '', icon: '🖱️', desc: 'เมาส์เกมมิ่งพรีเมียม' },
    { id: 'ms3', category: 'gamer', name: 'Gaming Mouse RGB', price: 25, image: '', icon: '🖱️', desc: 'เมาส์เกมมิ่งไฟ RGB' },
    { id: 'ms4', category: 'gamer', name: 'Gaming Mouse Lite', price: 25, image: '', icon: '🖱️', desc: 'เมาส์เกมมิ่งรุ่นเบสิค' }
  ]
});

initDataFile(USERS_FILE, {});
initDataFile(ORDERS_FILE, []);

const sessionStore = new Map(); // sessionId -> { events: [{productId, category, action, ts}], lastActive }
const SESSION_MAX_EVENTS = 50;
const SESSION_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessionStore.entries()) {
    if (now - s.lastActive > SESSION_TTL_MS) sessionStore.delete(sid);
  }
}, 5 * 60 * 1000);


const ACTION_WEIGHT = { view: 2, click: 1, cart: 3, purchase: 4 };

function timeDecay(ageMs) {
  const ageMin = ageMs / 60000;
  return Math.exp(-ageMin / 20);
}

function computeSessionAffinity(sessionId) {
  const categoryScore = {};
  const productScore = {};
  const session = sessionStore.get(sessionId);
  if (!session) return { categoryScore, productScore };
  const now = Date.now();
  session.events.forEach(function (ev) {
    const w = (ACTION_WEIGHT[ev.action] || 1) * timeDecay(now - ev.ts);
    if (ev.category) categoryScore[ev.category] = (categoryScore[ev.category] || 0) + w;
    productScore[ev.productId] = (productScore[ev.productId] || 0) + w;
  });
  return { categoryScore, productScore };
}


function buildOrderStats() {
  const orders = readJSON(ORDERS_FILE);
  const purchaseCount = {};
  const coOccur = {};

  orders.forEach(function (order) {
    const items = order.items || [];
    items.forEach(function (item) {
      purchaseCount[item.id] = (purchaseCount[item.id] || 0) + (Number(item.qty) || 1);
    });
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const a = items[i].id, b = items[j].id;
        if (!coOccur[a]) coOccur[a] = {};
        coOccur[a][b] = (coOccur[a][b] || 0) + 1;
      }
    }
  });

  return { purchaseCount, coOccur };
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}


function ensureAdminAccount() {
  const users = readJSON(USERS_FILE);
  const hasAdmin = Object.values(users).some(u => u.role === 'admin');
  if (!hasAdmin) {
    users['admin'] = {
      password: 'admin1234', 
      role: 'admin',
      createdAt: new Date().toISOString()
    };
    writeJSON(USERS_FILE, users);
    console.log(' สร้างบัญชีแอดมินเริ่มต้นแล้ว: username="admin" password="admin1234"');
  }
}
ensureAdminAccount();


// ==========================================
// API หมวดหมู่ (Categories) - เพิ่มใหม่
// ==========================================
app.get('/api/categories', (req, res) => {
  res.json(readJSON(CATEGORIES_FILE));
});

app.post('/api/categories', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณาระบุชื่อหมวดหมู่' });

  const categories = readJSON(CATEGORIES_FILE);
  if (categories.find(c => c.name === name)) {
    return res.status(400).json({ error: 'หมวดหมู่นี้มีอยู่แล้ว' });
  }

  const key = 'cat_' + Date.now();
  const newCat = { key, name };
  
  categories.push(newCat);
  writeJSON(CATEGORIES_FILE, categories);

  const products = readJSON(PRODUCTS_FILE);
  if (!products[key]) {
    products[key] = [];
    writeJSON(PRODUCTS_FILE, products);
  }

  res.status(201).json(newCat);
});

app.delete('/api/categories/:key', (req, res) => {
  const { key } = req.params;
  
  if (['foryou', 'trending', 'gamer'].includes(key)) {
    return res.status(400).json({ error: 'ไม่สามารถลบหมวดหมู่หลักได้' });
  }

  let categories = readJSON(CATEGORIES_FILE);
  const initialLength = categories.length;
  categories = categories.filter(c => c.key !== key);

  if (categories.length === initialLength) {
    return res.status(404).json({ error: 'ไม่พบหมวดหมู่' });
  }

  writeJSON(CATEGORIES_FILE, categories);

  const products = readJSON(PRODUCTS_FILE);
  if (products[key]) {
    delete products[key];
    writeJSON(PRODUCTS_FILE, products);
  }

  res.json({ success: true, message: 'ลบหมวดหมู่เรียบร้อย' });
});


// ==========================================
// API สินค้า (Products)
// ==========================================
app.get('/api/products', (req, res) => {
  res.json(readJSON(PRODUCTS_FILE));
});

app.get('/api/products/all', (req, res) => {
  const data = readJSON(PRODUCTS_FILE);
  let all = [];
  // ดึงสินค้าจากทุกหมวดหมู่ที่มีในไฟล์ ไม่จำกัดแค่หมวดหลัก
  for (const key in data) {
    all = all.concat(data[key]);
  }
  res.json(all);
});

app.post('/api/products', (req, res) => {
  const { category, name, price, image, icon, desc } = req.body;
  if (!category || !name || !price) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  }
  const data = readJSON(PRODUCTS_FILE);
  if (!data[category]) data[category] = [];
  const newProduct = {
    id: category.substring(0, 2) + Date.now(),
    category, name, price: Number(price),
    image: image || '', icon: icon || '📦', desc: desc || ''
  };
  data[category].push(newProduct);
  writeJSON(PRODUCTS_FILE, data);
  res.json({ success: true, product: newProduct });
});

app.put('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const { name, price, image, icon, desc } = req.body;
  const data = readJSON(PRODUCTS_FILE);
  let updated = null;
  for (const cat of Object.keys(data)) {
    const idx = data[cat].findIndex(p => p.id === id);
    if (idx !== -1) {
      data[cat][idx] = {
        ...data[cat][idx],
        name: name || data[cat][idx].name,
        price: price !== undefined ? Number(price) : data[cat][idx].price,
        image: image !== undefined ? image : data[cat][idx].image,
        icon: icon || data[cat][idx].icon,
        desc: desc !== undefined ? desc : data[cat][idx].desc
      };
      updated = data[cat][idx];
      break;
    }
  }
  if (!updated) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  writeJSON(PRODUCTS_FILE, data);
  res.json({ success: true, product: updated });
});

app.delete('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const data = readJSON(PRODUCTS_FILE);
  let deleted = false;
  for (const cat of Object.keys(data)) {
    const before = data[cat].length;
    data[cat] = data[cat].filter(p => p.id !== id);
    if (data[cat].length < before) { deleted = true; break; }
  }
  if (!deleted) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  writeJSON(PRODUCTS_FILE, data);
  res.json({ success: true });
});

// ==========================================
// API ระบบแนะนำ (Events & Recommendations)
// ==========================================
app.post('/api/events', (req, res) => {
  const { sessionId, productId, category, action } = req.body;
  if (!sessionId || !productId || !action) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (ต้องการ sessionId, productId, action)' });
  }
  if (!ACTION_WEIGHT[action]) {
    return res.status(400).json({ error: 'action ไม่ถูกต้อง' });
  }
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, { events: [], lastActive: Date.now() });
  }
  const session = sessionStore.get(sessionId);
  session.events.push({ productId, category: category || '', action, ts: Date.now() });
  if (session.events.length > SESSION_MAX_EVENTS) session.events.shift();
  session.lastActive = Date.now();
  res.json({ success: true });
});


app.get('/api/recommendations', (req, res) => {
  const sessionId = req.query.sessionId || '';
  const productId = req.query.productId || '';
  const cartIds = String(req.query.cartIds || '').split(',').filter(Boolean);
  const excludeIds = new Set(
    String(req.query.exclude || '').split(',').filter(Boolean)
      .concat(productId ? [productId] : [])
      .concat(cartIds)
  );
  const limit = Math.min(Math.max(Number(req.query.limit) || 4, 1), 12);

  const data = readJSON(PRODUCTS_FILE);
  
  // ปรับให้ดึงสินค้าทุกหมวดหมู่มารวมกัน เพื่อใช้ในระบบแนะนำ
  let allProducts = [];
  for (const key in data) {
    allProducts = allProducts.concat(data[key]);
  }

  const { purchaseCount, coOccur } = buildOrderStats();
  const { categoryScore } = computeSessionAffinity(sessionId);

  const referenceIds = productId ? [productId].concat(cartIds) : cartIds;
  const maxPurchase = Math.max(1, ...Object.values(purchaseCount));
  const hasCategorySignal = Object.keys(categoryScore).length > 0;

  const scored = allProducts
    .filter(function (p) { return !excludeIds.has(p.id); })
    .map(function (p) {
      let score = 0;

      referenceIds.forEach(function (refId) {
        if (coOccur[refId] && coOccur[refId][p.id]) {
          score += coOccur[refId][p.id] * 6;
        }
      });

      score += (categoryScore[p.category] || 0) * 3;
      score += ((purchaseCount[p.id] || 0) / maxPurchase) * 2;

      return Object.assign({}, p, { _score: score });
    })
    .sort(function (a, b) { return b._score - a._score; });

  let reason = 'popular';
  if (referenceIds.length && scored.some(function (p) { return p._score > 0; })) {
    reason = 'related';
  } else if (hasCategorySignal && scored.some(function (p) { return p._score > 0; })) {
    reason = 'personalized';
  }

  const recommendations = scored.slice(0, limit).map(function (p) {
    const clean = Object.assign({}, p);
    delete clean._score;
    return clean;
  });

  res.json({ recommendations: recommendations, reason: reason });
});

// ==========================================
// API ผู้ใช้ (Auth)
// ==========================================
app.post('/api/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  }
  const users = readJSON(USERS_FILE);
  if (users[username]) {
    return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
  }
  users[username] = { password, role: 'user', createdAt: new Date().toISOString() };
  writeJSON(USERS_FILE, users);
  res.json({ success: true, message: 'สมัครสำเร็จ' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(USERS_FILE);
  if (!users[username] || users[username].password !== password) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  res.json({
    success: true,
    user: { username, role: users[username].role || 'user' }
  });
});

// ==========================================
// API คำสั่งซื้อ (Orders)
// ==========================================
app.get('/api/orders/:username', (req, res) => {
  const orders = readJSON(ORDERS_FILE).filter(o => o.user === req.params.username);
  res.json(orders);
});

app.post('/api/orders', (req, res) => {
  const { user, items, total } = req.body;
  if (!user || !items || items.length === 0) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  }
  const orders = readJSON(ORDERS_FILE);
  const newOrder = {
    id: 'ORD' + Date.now(),
    user, items, total: Number(total),
    status: 'สั่งซื้อสำเร็จ',
    createdAt: new Date().toISOString()
  };
  orders.push(newOrder);
  writeJSON(ORDERS_FILE, orders);
  res.json({ success: true, order: newOrder });
});

// Run
app.listen(PORT, () => {
  console.log(` Backend รันที่ http://localhost:${PORT}`);
  console.log(` ฐานข้อมูลอยู่ที่: ${DATA_DIR}`);
});