// ============================================
// Supplier Service - 主程式
// Port: 3010
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './database/postgres';
import { verifyToken, requireRole } from './middleware/auth';
import { SERVICE_PORTS } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.SUPPLIER;

app.use(cors());
app.use(express.json());

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        company_name VARCHAR(255) NOT NULL,
        contact_name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(50),
        country VARCHAR(100),
        city VARCHAR(100),
        address TEXT,
        bank_info JSONB,
        commission_rate DECIMAL(5,2) DEFAULT 10.00,
        status VARCHAR(20) DEFAULT 'active',
        verified BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS supplier_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        supplier_id UUID REFERENCES suppliers(id),
        order_id UUID REFERENCES orders(id),
        status VARCHAR(20) DEFAULT 'pending',
        shipped_at TIMESTAMP,
        delivered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_suppliers_user ON suppliers(user_id);
      CREATE INDEX IF NOT EXISTS idx_supplier_orders_supplier ON supplier_orders(supplier_id);
    `);
    console.log('✅ Supplier database initialized');
  } finally { client.release(); }
}

// GET /api/v1/suppliers - 取得供應商列表
app.get('/api/v1/suppliers', async (req: Request, res: Response) => {
  try {
    const { status, verified } = req.query;
    let query = 'SELECT s.*, u.email as user_email FROM suppliers s LEFT JOIN users u ON u.id = s.user_id WHERE 1=1';
    const params: any[] = [];
    let idx = 1;

    if (status) { query += ` AND s.status = $${idx++}`; params.push(status); }
    if (verified) { query += ` AND s.verified = $${idx++}`; params.push(verified === 'true'); }

    query += ' ORDER BY s.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get suppliers' } });
  }
});

// GET /api/v1/suppliers/me - 取得我的供應商資料
app.get('/api/v1/suppliers/me', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const result = await pool.query('SELECT * FROM suppliers WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Supplier profile not found' } });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get supplier' } });
  }
});

// POST /api/v1/suppliers - 建立供應商
app.post('/api/v1/suppliers', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { companyName, contactName, email, phone, country, city, address, bankInfo } = req.body;

    if (!companyName) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Company name is required' } });
    }

    const result = await pool.query(
      `INSERT INTO suppliers (user_id, company_name, contact_name, email, phone, country, city, address, bank_info)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [userId, companyName, contactName, email, phone, country, city, address, JSON.stringify(bankInfo)]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create supplier' } });
  }
});

// PUT /api/v1/suppliers/me - 更新供應商資料
app.put('/api/v1/suppliers/me', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { companyName, contactName, email, phone, country, city, address, bankInfo } = req.body;

    const result = await pool.query(
      `UPDATE suppliers SET company_name = COALESCE($1, company_name), contact_name = COALESCE($2, contact_name),
       email = COALESCE($3, email), phone = COALESCE($4, phone), country = COALESCE($5, country),
       city = COALESCE($6, city), address = COALESCE($7, address), bank_info = COALESCE($8, bank_info),
       updated_at = NOW() WHERE user_id = $9 RETURNING *`,
      [companyName, contactName, email, phone, country, city, address, bankInfo ? JSON.stringify(bankInfo) : null, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Supplier not found' } });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update supplier' } });
  }
});

// GET /api/v1/suppliers/:id/products - 取得供應商商品
app.get('/api/v1/suppliers/:id/products', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page = '1', limit = '20' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const result = await pool.query(
      'SELECT * FROM products WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [id, limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM products WHERE supplier_id = $1', [id]);

    res.json({
      success: true,
      data: result.rows,
      pagination: { page: parseInt(page as string), limit: parseInt(limit as string), total: parseInt(countResult.rows[0].count) }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get products' } });
  }
});

// GET /api/v1/suppliers/orders - 取得供應商訂單
app.get('/api/v1/suppliers/orders', verifyToken, requireRole(['supplier', 'admin']), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const userRole = (req as any).user.role;

    let query = `
      SELECT so.*, o.order_number, o.total as order_total, o.shipping_address, o.status as order_status
      FROM supplier_orders so
      JOIN orders o ON o.id = so.order_id
      JOIN suppliers s ON s.id = so.supplier_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let idx = 1;

    if (userRole === 'supplier') {
      query += ` AND s.user_id = $${idx++}`;
      params.push(userId);
    }

    query += ' ORDER BY so.created_at DESC LIMIT 50';
    const result = await pool.query(query, params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get orders' } });
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function start() {
  try { await initDatabase(); app.listen(PORT, () => console.log(`🚀 Supplier Service running on port ${PORT}`)); }
  catch (error) { console.error('Failed to start:', error); process.exit(1); }
}
start();
