// ============================================
// Category Service - 主程式
// Port: 3004
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './database/postgres';
import { cacheGetObject, cacheSetObject, cacheDelete } from './database/redis';
import { verifyToken, requireRole } from './middleware/auth';
import { SERVICE_PORTS, CACHE_TTL } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.CATEGORY;

app.use(cors());
app.use(express.json());

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        name_en VARCHAR(255),
        parent_id UUID REFERENCES categories(id) ON DELETE SET NULL,
        sort_order INT DEFAULT 0,
        image VARCHAR(500),
        icon VARCHAR(100),
        description TEXT,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
      CREATE INDEX IF NOT EXISTS idx_categories_status ON categories(status);
    `);
    console.log('✅ Category database initialized');
  } finally { client.release(); }
}

// GET /api/v1/categories - 取得分類列表
app.get('/api/v1/categories', async (req: Request, res: Response) => {
  try {
    const { tree } = req.query;
    const cacheKey = `categories:tree:${tree || 'flat'}`;
    const cached = await cacheGetObject(cacheKey);
    if (cached) return res.json({ success: true, data: cached });

    let result;
    if (tree === 'true') {
      // Build tree structure
      const flat = await pool.query('SELECT * FROM categories WHERE status = $1 ORDER BY sort_order, name', ['active']);
      const treeData = buildTree(flat.rows);
      await cacheSetObject(cacheKey, treeData, CACHE_TTL.CATEGORY);
      result = treeData;
    } else {
      result = await pool.query('SELECT * FROM categories WHERE status = $1 ORDER BY sort_order, name', ['active']);
      await cacheSetObject(cacheKey, result.rows, CACHE_TTL.CATEGORY);
      result = result.rows;
    }
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get categories' } });
  }
});

function buildTree(categories: any[]): any[] {
  const map: Record<string, any> = {};
  const roots: any[] = [];
  
  categories.forEach(c => {
    map[c.id] = { ...c, children: [] };
  });
  
  categories.forEach(c => {
    if (c.parent_id && map[c.parent_id]) {
      map[c.parent_id].children.push(map[c.id]);
    } else {
      roots.push(map[c.id]);
    }
  });
  
  return roots;
}

// GET /api/v1/categories/:id - 取得單一分類
app.get('/api/v1/categories/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM categories WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Category not found' } });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get category' } });
  }
});

// POST /api/v1/categories - 建立分類
app.post('/api/v1/categories', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { name, nameEn, parentId, sortOrder, image, icon, description } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name is required' } });
    }
    const result = await pool.query(
      `INSERT INTO categories (name, name_en, parent_id, sort_order, image, icon, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, nameEn, parentId, sortOrder || 0, image, icon, description]
    );
    await cacheDelete('categories:tree:');
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create category' } });
  }
});

// PUT /api/v1/categories/:id - 更新分類
app.put('/api/v1/categories/:id', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, nameEn, parentId, sortOrder, image, icon, description, status } = req.body;
    const result = await pool.query(
      `UPDATE categories SET name = COALESCE($1, name), name_en = COALESCE($2, name_en), parent_id = COALESCE($3, parent_id),
       sort_order = COALESCE($4, sort_order), image = COALESCE($5, image), icon = COALESCE($6, icon),
       description = COALESCE($7, description), status = COALESCE($8, status), updated_at = NOW() WHERE id = $9 RETURNING *`,
      [name, nameEn, parentId, sortOrder, image, icon, description, status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Category not found' } });
    }
    await cacheDelete('categories:tree:');
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update category' } });
  }
});

// DELETE /api/v1/categories/:id - 刪除分類
app.delete('/api/v1/categories/:id', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE categories SET status = $1 WHERE id = $2', ['deleted', id]);
    await cacheDelete('categories:tree:');
    res.json({ success: true, data: { message: 'Category deleted' } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete category' } });
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function start() {
  try { await initDatabase(); app.listen(PORT, () => console.log(`🚀 Category Service running on port ${PORT}`)); }
  catch (error) { console.error('Failed to start:', error); process.exit(1); }
}
start();
