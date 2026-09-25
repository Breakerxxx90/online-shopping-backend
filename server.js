const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

if (!process.env.DATABASE_URL) {
  console.error('ไม่พบ DATABASE_URL กรุณาตั้งค่า environment variable ก่อนรันเซิร์ฟเวอร์');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// สร้างบัญชีแอดมินเริ่มต้นถ้ายังไม่มี
async function ensureAdminAccount() {
  const { rows } = await pool.query(`SELECT 1 FROM Users WHERE Role = 'admin' LIMIT 1`);
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO Users (Username, Password, Role) VALUES ($1, $2, $3)
       ON CONFLICT (Username) DO NOTHING`,
      ['admin', 'admin1234', 'admin']
    );
    console.log('สร้างบัญชีแอดมินเริ่มต้นแล้ว: username="admin" password="admin1234"');
  }
}
ensureAdminAccount().catch(err => console.error('ensureAdminAccount error:', err));

// เก็บพฤติกรรมการดูสินค้าไว้ในหน่วยความจำ (ไม่จำเป็นต้องอยู่ถาวร)
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

async function buildOrderStats() {
  const { rows: orders } = await pool.query(`SELECT Items FROM Orders`);
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

function rowToProduct(row) {
  return {
    id: row.productid,
    category: row.categoryid,
    name: row.productname,
    price: Number(row.price),
    image: row.image || '',
    icon: row.icon || '',
    desc: row.description || ''
  };
}

// ==========================================
// API หมวดหมู่ (Categories)
// ==========================================
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT CategoryID, CategoryName FROM Categories ORDER BY CategoryID`);
    res.json(rows.map(r => ({ key: r.categoryid, name: r.categoryname })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ดึงข้อมูลหมวดหมู่ไม่สำเร็จ' });
  }
});

app.post('/api/categories', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'กรุณาระบุชื่อหมวดหมู่' });

    const existing = await pool.query(`SELECT 1 FROM Categories WHERE CategoryName = $1`, [name]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'หมวดหมู่นี้มีอยู่แล้ว' });
    }

    const key = 'cat_' + Date.now();
    await pool.query(`INSERT INTO Categories (CategoryID, CategoryName) VALUES ($1, $2)`, [key, name]);
    res.status(201).json({ key, name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'สร้างหมวดหมู่ไม่สำเร็จ' });
  }
});

app.delete('/api/categories/:key', async (req, res) => {
  try {
    const { key } = req.params;
    if (['foryou', 'trending', 'gamer'].includes(key)) {
      return res.status(400).json({ error: 'ไม่สามารถลบหมวดหมู่หลักได้' });
    }
    const result = await pool.query(`DELETE FROM Categories WHERE CategoryID = $1`, [key]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'ไม่พบหมวดหมู่' });
    }
    res.json({ success: true, message: 'ลบหมวดหมู่เรียบร้อย' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ลบหมวดหมู่ไม่สำเร็จ' });
  }
});

// ==========================================
// API สินค้า (Products)
// ==========================================
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM Products ORDER BY CategoryID, ProductID`);
    const grouped = {};
    rows.forEach(row => {
      const cat = row.categoryid || 'uncategorized';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(rowToProduct(row));
    });
    res.json(grouped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ดึงข้อมูลสินค้าไม่สำเร็จ' });
  }
});

app.get('/api/products/all', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM Products`);
    res.json(rows.map(rowToProduct));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ดึงข้อมูลสินค้าไม่สำเร็จ' });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { category, name, price, image, icon, desc } = req.body;
    if (!category || !name || !price) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    const id = category.substring(0, 2) + Date.now();
    await pool.query(
      `INSERT INTO Products (ProductID, ProductName, CategoryID, Price, Description, Image, Icon)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, category, Number(price), desc || '', image || '', icon || '📦']
    );
    res.json({
      success: true,
      product: { id, category, name, price: Number(price), image: image || '', icon: icon || '📦', desc: desc || '' }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เพิ่มสินค้าไม่สำเร็จ' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, image, icon, desc } = req.body;
    const { rows } = await pool.query(`SELECT * FROM Products WHERE ProductID = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    const current = rows[0];
    const updated = {
      name: name || current.productname,
      price: price !== undefined ? Number(price) : Number(current.price),
      image: image !== undefined ? image : current.image,
      icon: icon || current.icon,
      desc: desc !== undefined ? desc : current.description
    };
    await pool.query(
      `UPDATE Products SET ProductName = $1, Price = $2, Image = $3, Icon = $4, Description = $5 WHERE ProductID = $6`,
      [updated.name, updated.price, updated.image, updated.icon, updated.desc, id]
    );
    res.json({ success: true, product: { id, category: current.categoryid, ...updated } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'แก้ไขสินค้าไม่สำเร็จ' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM Products WHERE ProductID = $1`, [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ลบสินค้าไม่สำเร็จ' });
  }
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

app.get('/api/recommendations', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || '';
    const productId = req.query.productId || '';
    const cartIds = String(req.query.cartIds || '').split(',').filter(Boolean);
    const excludeIds = new Set(
      String(req.query.exclude || '').split(',').filter(Boolean)
        .concat(productId ? [productId] : [])
        .concat(cartIds)
    );
    const limit = Math.min(Math.max(Number(req.query.limit) || 4, 1), 12);

    const { rows } = await pool.query(`SELECT * FROM Products`);
    const allProducts = rows.map(rowToProduct);

    const { purchaseCount, coOccur } = await buildOrderStats();
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

    res.json({ recommendations, reason });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ดึงคำแนะนำไม่สำเร็จ' });
  }
});

// ==========================================
// API ผู้ใช้ (Auth)
// ==========================================
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    const existing = await pool.query(`SELECT 1 FROM Users WHERE Username = $1`, [username]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
    }
    await pool.query(`INSERT INTO Users (Username, Password, Role) VALUES ($1, $2, 'user')`, [username, password]);
    res.json({ success: true, message: 'สมัครสำเร็จ' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'สมัครสมาชิกไม่สำเร็จ' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await pool.query(`SELECT * FROM Users WHERE Username = $1`, [username]);
    const user = rows[0];
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    res.json({ success: true, user: { username, role: user.role || 'user' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เข้าสู่ระบบไม่สำเร็จ' });
  }
});

// ==========================================
// API คำสั่งซื้อ (Orders)
// ==========================================
app.get('/api/orders/:username', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT OrderID AS id, Username AS "user", Items AS items, Total AS total, Status AS status, CreatedAt AS "createdAt"
       FROM Orders WHERE Username = $1 ORDER BY CreatedAt DESC`,
      [req.params.username]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ดึงคำสั่งซื้อไม่สำเร็จ' });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { user, items, total } = req.body;
    if (!user || !items || items.length === 0) {
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    }
    const id = 'ORD' + Date.now();
    const status = 'สั่งซื้อสำเร็จ';
    const createdAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO Orders (OrderID, Username, Items, Total, Status, CreatedAt) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, user, JSON.stringify(items), Number(total), status, createdAt]
    );
    res.json({ success: true, order: { id, user, items, total: Number(total), status, createdAt } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'สร้างคำสั่งซื้อไม่สำเร็จ' });
  }
});

// Run
app.listen(PORT, () => {
  console.log(`Backend รันที่พอร์ต ${PORT}`);
  console.log('ฐานข้อมูล: Neon Postgres (ผ่าน DATABASE_URL)');
});