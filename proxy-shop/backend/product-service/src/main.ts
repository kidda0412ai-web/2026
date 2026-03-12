// ============================================
// Product Service - 主程式
// Port: 3003
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { pool } from './database/postgres';
import { cacheGetObject, cacheSetObject, cacheDelete } from './database/redis';
import { Product, ProductCategory } from '@proxy-shop/shared';
import { generateId, isValidURL, paginate, PaginationParams } from '@proxy-shop/shared';
import { SERVICE_PORTS, UPLOAD_CONFIG, CACHE_TTL } from '@proxy-shop/shared';
import { verifyToken, requireRole } from './middleware/auth';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.Product;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: UPLOAD_CONFIG.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (UPLOAD_CONFIG.ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// ---------- Database Schema ----------
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        name_en VARCHAR(255),
        parent_id UUID REFERENCES categories(id),
        sort_order INT DEFAULT 0,
        image VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        supplier_id UUID NOT NULL,
        name VARCHAR(500) NOT NULL,
        description TEXT,
        category_id UUID REFERENCES categories(id),
        price DECIMAL(10,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'JPY',
        original_price DECIMAL(10,2),
        stock INT DEFAULT 0,
        reserved_stock INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        tags TEXT[],
        images TEXT[],
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS product_images (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES products(id) ON DELETE CASCADE,
        url VARCHAR(500) NOT NULL,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
      CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
    `);
    console.log('✅ Product database initialized');
  } finally {
    client.release();
  }
}

// ---------- Cache Helpers ----------
const PRODUCT_CACHE_TTL = CACHE_TTL.PRODUCT;
const CATEGORY_CACHE_TTL = CACHE_TTL.CATEGORY;

// ---------- Product Routes ----------

// GET /api/v1/products - 取得商品列表
app.get('/api/v1/products', async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20', category, status = 'active', supplier, search } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    let query = `
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND p.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (category) {
      query += ` AND p.category_id = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (supplier) {
      query += ` AND p.supplier_id = $${paramIndex}`;
      params.push(supplier);
      paramIndex++;
    }

    if (search) {
      query += ` AND (p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY p.created_at DESC`;

    // Get total count
    const countQuery = query.replace('SELECT p.*, c.name as category_name', 'SELECT COUNT(*)');
    const totalResult = await pool.query(countQuery, params);
    const total = parseInt(totalResult.rows[0].count);

    // Get paginated results
    const offset = (pageNum - 1) * limitNum;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get products' }
    });
  }
});

// GET /api/v1/products/:id - 取得單一商品
app.get('/api/v1/products/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Try cache first
    const cacheKey = `product:${id}`;
    const cached = await cacheGetObject<Product>(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    const result = await pool.query(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Product not found' }
      });
    }

    const product = result.rows[0];

    // Cache it
    await cacheSetObject(cacheKey, product, PRODUCT_CACHE_TTL);

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get product' }
    });
  }
});

// POST /api/v1/products - 建立商品 (Supplier/Admin only)
app.post('/api/v1/products', verifyToken, requireRole(['supplier', 'admin']), async (req: Request, res: Response) => {
  try {
    const { name, description, categoryId, price, currency, originalPrice, stock, status, tags, images } = req.body;
    const supplierId = (req as any).user.userId;

    if (!name || !price) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Name and price are required' }
      });
    }

    const result = await pool.query(
      `INSERT INTO products (supplier_id, name, description, category_id, price, currency, original_price, stock, status, tags, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [supplierId, name, description, categoryId, price, currency || 'JPY', originalPrice, stock || 0, status || 'active', tags || [], images || []]
    );

    const product = result.rows[0];

    // Invalidate supplier cache
    await cacheDelete(`supplier:${supplierId}:products`);

    res.status(201).json({ success: true, data: product });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create product' }
    });
  }
});

// PUT /api/v1/products/:id - 更新商品
app.put('/api/v1/products/:id', verifyToken, requireRole(['supplier', 'admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;
    const userRole = (req as any).user.role;

    // Check ownership or admin
    const productCheck = await pool.query('SELECT supplier_id FROM products WHERE id = $1', [id]);
    if (productCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Product not found' }
      });
    }

    if (productCheck.rows[0].supplier_id !== userId && userRole !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized' }
      });
    }

    const { name, description, categoryId, price, currency, originalPrice, stock, reservedStock, status, tags, images } = req.body;

    const result = await pool.query(
      `UPDATE products 
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           category_id = COALESCE($3, category_id),
           price = COALESCE($4, price),
           currency = COALESCE($5, currency),
           original_price = COALESCE($6, original_price),
           stock = COALESCE($7, stock),
           reserved_stock = COALESCE($8, reserved_stock),
           status = COALESCE($9, status),
           tags = COALESCE($10, tags),
           images = COALESCE($11, images),
           updated_at = NOW()
       WHERE id = $12
       RETURNING *`,
      [name, description, categoryId, price, currency, originalPrice, stock, reservedStock, status, tags, images, id]
    );

    // Invalidate cache
    await cacheDelete(`product:${id}`);

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update product' }
    });
  }
});

// DELETE /api/v1/products/:id - 刪除商品
app.delete('/api/v1/products/:id', verifyToken, requireRole(['supplier', 'admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;
    const userRole = (req as any).user.role;

    const productCheck = await pool.query('SELECT supplier_id FROM products WHERE id = $1', [id]);
    if (productCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Product not found' }
      });
    }

    if (productCheck.rows[0].supplier_id !== userId && userRole !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized' }
      });
    }

    await pool.query('DELETE FROM products WHERE id = $1', [id]);

    // Invalidate cache
    await cacheDelete(`product:${id}`);

    res.json({ success: true, data: { message: 'Product deleted' } });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete product' }
    });
  }
});

// POST /api/v1/products/:id/images - 上傳商品圖片
app.post('/api/v1/products/:id/images', verifyToken, requireRole(['supplier', 'admin']), upload.array('images', 10), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_FILES', message: 'No files uploaded' }
      });
    }

    // Get existing images
    const product = await pool.query('SELECT images FROM products WHERE id = $1', [id]);
    if (product.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Product not found' }
      });
    }

    const existingImages = product.rows[0].images || [];
    const newImages = files.map(f => `/uploads/${f.filename}`);
    const allImages = [...existingImages, ...newImages];

    await pool.query(
      'UPDATE products SET images = $1, updated_at = NOW() WHERE id = $2',
      [allImages, id]
    );

    // Invalidate cache
    await cacheDelete(`product:${id}`);

    res.json({ success: true, data: { images: allImages } });
  } catch (error) {
    console.error('Upload images error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to upload images' }
    });
  }
});

// ---------- Category Routes ----------

// GET /api/v1/categories - 取得分類列表
app.get('/api/v1/categories', async (req: Request, res: Response) => {
  try {
    const { parent } = req.query;

    // Try cache first
    const cacheKey = `categories:${parent || 'all'}`;
    const cached = await cacheGetObject<ProductCategory[]>(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    let query = 'SELECT * FROM categories';
    const params: any[] = [];

    if (parent === 'root' || parent === undefined) {
      query += ' WHERE parent_id IS NULL';
    } else if (parent) {
      query += ' WHERE parent_id = $1';
      params.push(parent);
    }

    query += ' ORDER BY sort_order, name';

    const result = await pool.query(query, params);

    // Cache it
    await cacheSetObject(cacheKey, result.rows, CATEGORY_CACHE_TTL);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get categories' }
    });
  }
});

// POST /api/v1/categories - 建立分類 (Admin only)
app.post('/api/v1/categories', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { name, nameEn, parentId, sortOrder, image } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Name is required' }
      });
    }

    const result = await pool.query(
      `INSERT INTO categories (name, name_en, parent_id, sort_order, image)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, nameEn, parentId, sortOrder || 0, image]
    );

    // Invalidate category cache
    await cacheDelete('categories:all');

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create category' }
    });
  }
});

// ---------- Stock Management ----------

// POST /api/v1/products/:id/reserve - 預扣庫存
app.post('/api/v1/products/:id/reserve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUANTITY', message: 'Invalid quantity' }
      });
    }

    // Use transaction for atomic operation
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row
      const product = await client.query(
        'SELECT stock, reserved_stock FROM products WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (product.rows.length === 0) {
        throw new Error('NOT_FOUND');
      }

      const availableStock = product.rows[0].stock - product.rows[0].reserved_stock;
      if (availableStock < quantity) {
        throw new Error('INSUFFICIENT_STOCK');
      }

      // Reserve stock
      await client.query(
        'UPDATE products SET reserved_stock = reserved_stock + $1, updated_at = NOW() WHERE id = $2',
        [quantity, id]
      );

      await client.query('COMMIT');

      // Invalidate cache
      await cacheDelete(`product:${id}`);

      res.json({ success: true, data: { message: 'Stock reserved' } });
    } catch (error: any) {
      await client.query('ROLLBACK');
      
      if (error.message === 'NOT_FOUND') {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Product not found' }
        });
      }
      
      if (error.message === 'INSUFFICIENT_STOCK') {
        return res.status(400).json({
          success: false,
          error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough stock' }
        });
      }
      
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Reserve stock error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reserve stock' }
    });
  }
});

// POST /api/v1/products/:id/release - 釋放預扣庫存
app.post('/api/v1/products/:id/release', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUANTITY', message: 'Invalid quantity' }
      });
    }

    await pool.query(
      'UPDATE products SET reserved_stock = GREATEST(0, reserved_stock - $1), updated_at = NOW() WHERE id = $2',
      [quantity, id]
    );

    // Invalidate cache
    await cacheDelete(`product:${id}`);

    res.json({ success: true, data: { message: 'Stock released' } });
  } catch (error) {
    console.error('Release stock error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to release stock' }
    });
  }
});

// POST /api/v1/products/:id/deduct - 正式扣除庫存
app.post('/api/v1/products/:id/deduct', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUANTITY', message: 'Invalid quantity' }
      });
    }

    await pool.query(
      'UPDATE products SET stock = stock - $1, reserved_stock = reserved_stock - $1, updated_at = NOW() WHERE id = $2',
      [quantity, id]
    );

    // Invalidate cache
    await cacheDelete(`product:${id}`);

    res.json({ success: true, data: { message: 'Stock deducted' } });
  } catch (error) {
    console.error('Deduct stock error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to deduct stock' }
    });
  }
});

// ---------- Error Handler ----------
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
  });
});

// ---------- Start Server ----------
async function start() {
  try {
    await initDatabase();
    
    app.listen(PORT, () => {
      console.log(`🚀 Product Service running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start Product Service:', error);
    process.exit(1);
  }
}

start();
