// ============================================
// Promotion Service - 主程式
// Port: 3008
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './database/postgres';
import { verifyToken, requireRole } from './middleware/auth';
import { SERVICE_PORTS } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.PROMOTION;

app.use(cors());
app.use(express.json());

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        code VARCHAR(50) UNIQUE,
        type VARCHAR(20) NOT NULL,
        value DECIMAL(10,2) NOT NULL,
        min_purchase DECIMAL(10,2),
        max_discount DECIMAL(10,2),
        start_at TIMESTAMP NOT NULL,
        end_at TIMESTAMP NOT NULL,
        usage_limit INT,
        usage_count INT DEFAULT 0,
        per_user_limit INT DEFAULT 1,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS promotion_products (
        promotion_id UUID REFERENCES promotions(id) ON DELETE CASCADE,
        product_id UUID REFERENCES products(id) ON DELETE CASCADE,
        PRIMARY KEY (promotion_id, product_id)
      );

      CREATE INDEX IF NOT EXISTS idx_promotions_code ON promotions(code);
      CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions(status);
    `);
    console.log('✅ Promotion database initialized');
  } finally { client.release(); }
}

// GET /api/v1/promotions - 取得促銷列表
app.get('/api/v1/promotions', async (req: Request, res: Response) => {
  try {
    const { active } = req.query;
    let query = 'SELECT * FROM promotions';
    const params: any[] = [];
    
    if (active === 'true') {
      query += ' WHERE status = $1 AND start_at <= NOW() AND end_at >= NOW()';
      params.push('active');
    }
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get promotions error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get promotions' } });
  }
});

// GET /api/v1/promotions/validate - 驗證優惠碼
app.get('/api/v1/promotions/validate', async (req: Request, res: Response) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ success: false, error: { code: 'NO_CODE', message: 'Code is required' } });
    }

    const result = await pool.query(
      `SELECT * FROM promotions WHERE code = $1 AND status = 'active' AND start_at <= NOW() AND end_at >= NOW()`,
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'INVALID_CODE', message: 'Invalid or expired promo code' } });
    }

    const promo = result.rows[0];
    
    if (promo.usage_limit && promo.usage_count >= promo.usage_limit) {
      return res.status(400).json({ success: false, error: { code: 'USAGE_EXCEEDED', message: 'Promo code usage limit exceeded' } });
    }

    res.json({ success: true, data: promo });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to validate promo code' } });
  }
});

// POST /api/v1/promotions - 建立促銷
app.post('/api/v1/promotions', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { name, description, code, type, value, minPurchase, maxDiscount, startAt, endAt, usageLimit, perUserLimit } = req.body;
    
    if (!name || !type || !value || !startAt || !endAt) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Required fields missing' } });
    }

    const result = await pool.query(
      `INSERT INTO promotions (name, description, code, type, value, min_purchase, max_discount, start_at, end_at, usage_limit, per_user_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [name, description, code, type, value, minPurchase, maxDiscount, startAt, endAt, usageLimit, perUserLimit || 1]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: { code: 'DUPLICATE_CODE', message: 'Promo code already exists' } });
    }
    console.error('Create promotion error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create promotion' } });
  }
});

// PUT /api/v1/promotions/:id - 更新促銷
app.put('/api/v1/promotions/:id', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, type, value, minPurchase, maxDiscount, startAt, endAt, usageLimit, perUserLimit, status } = req.body;
    
    const result = await pool.query(
      `UPDATE promotions SET name = COALESCE($1, name), description = COALESCE($2, description), type = COALESCE($3, type),
       value = COALESCE($4, value), min_purchase = COALESCE($5, min_purchase), max_discount = COALESCE($6, max_discount),
       start_at = COALESCE($7, start_at), end_at = COALESCE($8, end_at), usage_limit = COALESCE($9, usage_limit),
       per_user_limit = COALESCE($10, per_user_limit), status = COALESCE($11, status), updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [name, description, type, value, minPurchase, maxDiscount, startAt, endAt, usageLimit, perUserLimit, status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Promotion not found' } });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update promotion' } });
  }
});

// DELETE /api/v1/promotions/:id - 刪除促銷
app.delete('/api/v1/promotions/:id', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM promotions WHERE id = $1', [id]);
    res.json({ success: true, data: { message: 'Promotion deleted' } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete promotion' } });
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function start() {
  try { await initDatabase(); app.listen(PORT, () => console.log(`🚀 Promotion Service running on port ${PORT}`)); }
  catch (error) { console.error('Failed to start:', error); process.exit(1); }
}
start();
