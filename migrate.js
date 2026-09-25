// สคริปต์นำเข้าข้อมูลจากไฟล์ .json เดิม (ในโฟลเดอร์ data/) เข้า Neon Postgres
// วิธีใช้ (รันครั้งเดียวจากเครื่องตัวเอง หรือจาก Render Shell):
//   1) รัน schema.sql ใน Neon SQL Editor ก่อน
//   2) ตั้งค่า DATABASE_URL แล้วรัน: node migrate.js
//      Windows (PowerShell): $env:DATABASE_URL="postgres://..."; node migrate.js
//      Mac/Linux:             DATABASE_URL="postgres://..." node migrate.js

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ไม่พบ DATABASE_URL กรุณาตั้งค่า environment variable ก่อนรันสคริปต์นี้');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DATA_DIR = path.join(__dirname, 'data');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
}

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('เริ่ม migrate ข้อมูล...\n');

    // 1) Categories
    const categories = readJSON('categories.json');
    for (const c of categories) {
      await client.query(
        `INSERT INTO Categories (CategoryID, CategoryName) VALUES ($1, $2)
         ON CONFLICT (CategoryID) DO UPDATE SET CategoryName = EXCLUDED.CategoryName`,
        [c.key, c.name]
      );
    }
    console.log(`✔ นำเข้าหมวดหมู่แล้ว ${categories.length} รายการ`);

    // 2) Users
    const users = readJSON('users.json');
    const usernames = Object.keys(users);
    for (const username of usernames) {
      const u = users[username];
      await client.query(
        `INSERT INTO Users (Username, Password, Role, CreatedAt) VALUES ($1, $2, $3, $4)
         ON CONFLICT (Username) DO UPDATE SET Password = EXCLUDED.Password, Role = EXCLUDED.Role`,
        [username, u.password, u.role || 'user', u.createdAt || new Date().toISOString()]
      );
    }
    console.log(`✔ นำเข้าผู้ใช้แล้ว ${usernames.length} รายการ`);

    // 3) Products (ไฟล์เดิมเก็บเป็น object แยกตามหมวดหมู่)
    const productsByCategory = readJSON('products.json');
    let productCount = 0;
    for (const category of Object.keys(productsByCategory)) {
      for (const p of productsByCategory[category]) {
        await client.query(
          `INSERT INTO Products (ProductID, ProductName, CategoryID, Price, Description, Image, Icon)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (ProductID) DO UPDATE SET
             ProductName = EXCLUDED.ProductName, CategoryID = EXCLUDED.CategoryID,
             Price = EXCLUDED.Price, Description = EXCLUDED.Description,
             Image = EXCLUDED.Image, Icon = EXCLUDED.Icon`,
          [p.id, p.name, p.category || category, p.price, p.desc || '', p.image || '', p.icon || '📦']
        );
        productCount++;
      }
    }
    console.log(`✔ นำเข้าสินค้าแล้ว ${productCount} รายการ`);

    // 4) Orders
    const orders = readJSON('orders.json');
    for (const o of orders) {
      await client.query(
        `INSERT INTO Orders (OrderID, Username, Items, Total, Status, CreatedAt)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (OrderID) DO NOTHING`,
        [o.id, o.user, JSON.stringify(o.items), o.total, o.status, o.createdAt]
      );
    }
    console.log(`✔ นำเข้าคำสั่งซื้อแล้ว ${orders.length} รายการ`);

    console.log('\nเสร็จสิ้น! ข้อมูลทั้งหมดอยู่ใน Neon แล้ว');
  } catch (err) {
    console.error('\nเกิดข้อผิดพลาดระหว่าง migrate:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();