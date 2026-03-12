// ============================================
// Member Service - 主程式
// Port: 3002
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './database/postgres';
import { verifyToken } from './middleware/auth';
import { cacheGetObject, cacheSetObject, cacheDelete } from './database/redis';
import { SERVICE_PORTS, CACHE_TTL } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.MEMBER;

app.use(cors());
app.use(express.json());

async function initDatabase() {
  const client = await pool.connect();
  try {
    // User profiles already created in auth-service
    // Add additional member-specific tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS addresses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        country VARCHAR(100) NOT NULL,
        city VARCHAR(100) NOT NULL,
        district VARCHAR(100),
        zip_code VARCHAR(20),
        detail TEXT NOT NULL,
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS customs_info (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        real_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        id_number VARCHAR(20),
        ezway_number VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS favorites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, product_id)
      );

      CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);
      CREATE INDEX IF NOT EXISTS idx_customs_user ON customs_info(user_id);
      CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
    `);
    console.log('✅ Member database initialized');
  } finally {
    client.release();
  }
}

// GET /api/v1/member/profile - 取得會員資料
app.get('/api/v1/member/profile', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const cacheKey = `member:${userId}`;

    const cached = await cacheGetObject(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.phone, u.role, u.status, u.email_verified, u.created_at,
              up.avatar, up.bio
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    const user = result.rows[0];
    await cacheSetObject(cacheKey, user, CACHE_TTL.USER_SESSION);

    res.json({ success: true, data: user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get profile' } });
  }
});

// PUT /api/v1/member/profile - 更新會員資料
app.put('/api/v1/member/profile', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { name, phone } = req.body;

    const result = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, name, phone, role`,
      [name, phone, userId]
    );

    await cacheDelete(`member:${userId}`);

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update profile' } });
  }
});

// GET /api/v1/member/addresses - 取得收貨地址
app.get('/api/v1/member/addresses', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;

    const result = await pool.query(
      'SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
      [userId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get addresses error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get addresses' } });
  }
});

// POST /api/v1/member/addresses - 新增收貨地址
app.post('/api/v1/member/addresses', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { name, phone, country, city, district, zipCode, detail, isDefault } = req.body;

    if (!name || !phone || !country || !city || !detail) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Required fields missing' } });
    }

    // If setting as default, unset others
    if (isDefault) {
      await pool.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId]);
    }

    const result = await pool.query(
      `INSERT INTO addresses (user_id, name, phone, country, city, district, zip_code, detail, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [userId, name, phone, country, city, district, zipCode, detail, isDefault || false]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create address error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create address' } });
  }
});

// PUT /api/v1/member/addresses/:id - 更新收貨地址
app.put('/api/v1/member/addresses/:id', verifyToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;
    const { name, phone, country, city, district, zipCode, detail, isDefault } = req.body;

    // Verify ownership
    const check = await pool.query('SELECT user_id FROM addresses WHERE id = $1', [id]);
    if (check.rows.length === 0 || check.rows[0].user_id !== userId) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Address not found' } });
    }

    if (isDefault) {
      await pool.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId]);
    }

    const result = await pool.query(
      `UPDATE addresses 
       SET name = COALESCE($1, name), phone = COALESCE($2, phone), country = COALESCE($3, country),
           city = COALESCE($4, city), district = COALESCE($5, district), zip_code = COALESCE($6, zip_code),
           detail = COALESCE($7, detail), is_default = COALESCE($8, is_default), updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [name, phone, country, city, district, zipCode, detail, isDefault, id]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update address error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update address' } });
  }
});

// DELETE /api/v1/member/addresses/:id - 刪除收貨地址
app.delete('/api/v1/member/addresses/:id', verifyToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;

    const result = await pool.query(
      'DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Address not found' } });
    }

    res.json({ success: true, data: { message: 'Address deleted' } });
  } catch (error) {
    console.error('Delete address error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete address' } });
  }
});

// GET /api/v1/member/customs - 取得報關資料
app.get('/api/v1/member/customs', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;

    const result = await pool.query('SELECT * FROM customs_info WHERE user_id = $1', [userId]);

    res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    console.error('Get customs error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get customs info' } });
  }
});

// POST /api/v1/member/customs - 新增/更新報關資料
app.post('/api/v1/member/customs', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { realName, phone, idNumber, ezwayNumber } = req.body;

    if (!realName || !phone) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Real name and phone are required' } });
    }

    const result = await pool.query(
      `INSERT INTO customs_info (user_id, real_name, phone, id_number, ezway_number)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         real_name = EXCLUDED.real_name,
         phone = EXCLUDED.phone,
         id_number = EXCLUDED.id_number,
         ezway_number = EXCLUDED.ezway_number,
         updated_at = NOW()
       RETURNING *`,
      [userId, realName, phone, idNumber, ezwayNumber]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Save customs error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to save customs info' } });
  }
});

// GET /api/v1/member/favorites - 取得收藏清單
app.get('/api/v1/member/favorites', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;

    const result = await pool.query(
      `SELECT f.id, f.created_at, p.id as product_id, p.name, p.price, p.currency, p.images, p.stock
       FROM favorites f
       JOIN products p ON p.id = f.product_id
       WHERE f.user_id = $1
       ORDER BY f.created_at DESC`,
      [userId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get favorites error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get favorites' } });
  }
});

// POST /api/v1/member/favorites - 新增收藏
app.post('/api/v1/member/favorites', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Product ID is required' } });
    }

    await pool.query(
      'INSERT INTO favorites (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, productId]
    );

    res.status(201).json({ success: true, data: { message: 'Added to favorites' } });
  } catch (error) {
    console.error('Add favorite error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to add favorite' } });
  }
});

// DELETE /api/v1/member/favorites/:productId - 移除收藏
app.delete('/api/v1/member/favorites/:productId', verifyToken, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const userId = (req as any).user.userId;

    await pool.query(
      'DELETE FROM favorites WHERE user_id = $1 AND product_id = $2',
      [userId, productId]
    );

    res.json({ success: true, data: { message: 'Removed from favorites' } });
  } catch (error) {
    console.error('Remove favorite error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to remove favorite' } });
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, () => console.log(`🚀 Member Service running on port ${PORT}`));
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
