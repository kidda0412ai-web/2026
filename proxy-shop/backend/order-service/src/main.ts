// ============================================
// Order Service - 主程式
// Port: 3005
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './database/postgres';
import { connectRabbitMQ, publishMessage } from './database/rabbitmq';
import { verifyToken, requireRole } from './middleware/auth';
import { Order, OrderItem, OrderStatus } from '@proxy-shop/shared';
import { generateId, generateOrderNumber, calculateTotal, calculateShippingFee, convertToTWD } from '@proxy-shop/shared';
import { SERVICE_PORTS, SHIPPING_FEE } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.ORDER;

// Middleware
app.use(cors());
app.use(express.json());

// ---------- Database Schema ----------
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_number VARCHAR(50) UNIQUE NOT NULL,
        user_id UUID NOT NULL,
        subtotal DECIMAL(10,2) NOT NULL,
        shipping_fee DECIMAL(10,2) DEFAULT 60,
        tax DECIMAL(10,2) DEFAULT 0,
        discount DECIMAL(10,2) DEFAULT 0,
        total DECIMAL(10,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'TWD',
        status VARCHAR(20) DEFAULT 'pending',
        payment_status VARCHAR(20) DEFAULT 'pending',
        shipping_status VARCHAR(20) DEFAULT 'not_shipped',
        shipping_address JSONB NOT NULL,
        customs_info JSONB,
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
        product_id UUID NOT NULL,
        product_name VARCHAR(500) NOT NULL,
        product_image VARCHAR(500),
        price DECIMAL(10,2) NOT NULL,
        quantity INT NOT NULL,
        subtotal DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    `);
    console.log('✅ Order database initialized');
  } finally {
    client.release();
  }
}

// ---------- Order Routes ----------

// POST /api/v1/orders - 建立訂單
app.post('/api/v1/orders', verifyToken, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const userId = (req as any).user.userId;
    const { items, shippingAddress, customsInfo, note, promotionCode } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_ITEMS', message: 'No items in cart' }
      });
    }

    if (!shippingAddress || !shippingAddress.name || !shippingAddress.phone || !shippingAddress.detail) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ADDRESS', message: 'Invalid shipping address' }
      });
    }

    await client.query('BEGIN');

    // Calculate totals
    let subtotal = 0;
    const orderItems: any[] = [];

    for (const item of items) {
      // Get product price
      const productResult = await client.query(
        'SELECT name, price, currency, images, stock, reserved_stock FROM products WHERE id = $1 AND status = $2',
        [item.productId, 'active']
      );

      if (productResult.rows.length === 0) {
        throw new Error(`PRODUCT_NOT_FOUND:${item.productId}`);
      }

      const product = productResult.rows[0];
      const availableStock = product.stock - product.reserved_stock;

      if (availableStock < item.quantity) {
        throw new Error(`INSUFFICIENT_STOCK:${product.name}`);
      }

      // Reserve stock
      await client.query(
        'UPDATE products SET reserved_stock = reserved_stock + $1 WHERE id = $2',
        [item.quantity, item.productId]
      );

      // Convert to TWD
      const priceInTWD = convertToTWD(product.price, product.currency);
      const itemSubtotal = priceInTWD * item.quantity;
      subtotal += itemSubtotal;

      orderItems.push({
        productId: item.productId,
        productName: product.name,
        productImage: product.images?.[0] || '',
        price: priceInTWD,
        quantity: item.quantity,
        subtotal: itemSubtotal
      });
    }

    // Apply promotion if any
    let discount = 0;
    if (promotionCode) {
      const promoResult = await client.query(
        'SELECT * FROM promotions WHERE code = $1 AND status = $2 AND start_at <= NOW() AND end_at >= NOW()',
        [promotionCode, 'active']
      );

      if (promoResult.rows.length > 0) {
        const promo = promoResult.rows[0];
        if (!promo.usage_limit || promo.usage_count < promo.usage_limit) {
          if (!promo.min_purchase || subtotal >= promo.min_purchase) {
            if (promo.type === 'percentage') {
              discount = subtotal * (promo.value / 100);
              if (promo.max_discount && discount > promo.max_discount) {
                discount = promo.max_discount;
              }
            } else if (promo.type === 'fixed') {
              discount = promo.value;
            }
          }
        }
      }
    }

    // Calculate shipping fee
    const shippingFee = calculateShippingFee(subtotal - discount, SHIPPING_FEE.FREE_THRESHOLD);

    // Calculate total
    const total = calculateTotal(subtotal, shippingFee, discount);

    // Create order
    const orderNumber = generateOrderNumber();
    const orderResult = await client.query(
      `INSERT INTO orders (order_number, user_id, subtotal, shipping_fee, tax, discount, total, shipping_address, customs_info, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [orderNumber, userId, subtotal, shippingFee, 0, discount, total, JSON.stringify(shippingAddress), JSON.stringify(customsInfo), note]
    );

    const order = orderResult.rows[0];

    // Create order items
    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, product_image, price, quantity, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, item.productId, item.productName, item.productImage, item.price, item.quantity, item.subtotal]
      );
    }

    // Update promotion usage
    if (promotionCode && discount > 0) {
      await client.query(
        'UPDATE promotions SET usage_count = usage_count + 1 WHERE code = $1',
        [promotionCode]
      );
    }

    await client.query('COMMIT');

    // Publish order created event
    try {
      await publishMessage('order.created', {
        orderId: order.id,
        orderNumber: order.order_number,
        userId,
        total,
        items: orderItems
      });
    } catch (e) {
      console.error('Failed to publish order.created event:', e);
    }

    res.status(201).json({
      success: true,
      data: {
        ...order,
        items: orderItems
      }
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    
    if (error.message.startsWith('PRODUCT_NOT_FOUND:')) {
      return res.status(404).json({
        success: false,
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' }
      });
    }
    
    if (error.message.startsWith('INSUFFICIENT_STOCK:')) {
      return res.status(400).json({
        success: false,
        error: { code: 'INSUFFICIENT_STOCK', message: `Not enough stock for ${error.message.split(':')[1]}` }
      });
    }

    console.error('Create order error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create order' }
    });
  } finally {
    client.release();
  }
});

// GET /api/v1/orders - 取得用戶訂單列表
app.get('/api/v1/orders', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { page = '1', limit = '20', status } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);

    let query = 'SELECT * FROM orders WHERE user_id = $1';
    const params: any[] = [userId];
    let paramIndex = 2;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    // Get total count
    const countResult = await pool.query(
      query.replace('SELECT *', 'SELECT COUNT(*)'),
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results
    const offset = (pageNum - 1) * limitNum;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);

    // Get items for each order
    const orders = await Promise.all(result.rows.map(async (order) => {
      const itemsResult = await pool.query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [order.id]
      );
      return { ...order, items: itemsResult.rows };
    }));

    res.json({
      success: true,
      data: orders,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get orders' }
    });
  }
});

// GET /api/v1/orders/:id - 取得單一訂單
app.get('/api/v1/orders/:id', verifyToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;
    const userRole = (req as any).user.role;

    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Order not found' }
      });
    }

    const order = result.rows[0];

    // Check ownership or admin
    if (order.user_id !== userId && userRole !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized' }
      });
    }

    // Get items
    const itemsResult = await pool.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [id]
    );

    res.json({
      success: true,
      data: { ...order, items: itemsResult.rows }
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get order' }
    });
  }
});

// PUT /api/v1/orders/:id/cancel - 取消訂單
app.put('/api/v1/orders/:id/cancel', verifyToken, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;

    await client.query('BEGIN');

    // Check order exists and ownership
    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (orderResult.rows.length === 0) {
      throw new Error('NOT_FOUND');
    }

    const order = orderResult.rows[0];

    // Check if cancelable
    if (!['pending', 'paid'].includes(order.status)) {
      throw new Error('NOT_CANCELABLE');
    }

    // Release stock
    const itemsResult = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [id]
    );

    for (const item of itemsResult.rows) {
      await client.query(
        'UPDATE products SET reserved_stock = GREATEST(0, reserved_stock - $1) WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // Update order status
    await client.query(
      'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
      ['cancelled', id]
    );

    await client.query('COMMIT');

    // Publish order cancelled event
    try {
      await publishMessage('order.cancelled', { orderId: id, userId });
    } catch (e) {
      console.error('Failed to publish order.cancelled event:', e);
    }

    res.json({ success: true, data: { message: 'Order cancelled' } });
  } catch (error: any) {
    await client.query('ROLLBACK');
    
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Order not found' }
      });
    }
    
    if (error.message === 'NOT_CANCELABLE') {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_CANCELABLE', message: 'Order cannot be cancelled' }
      });
    }

    console.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel order' }
    });
  } finally {
    client.release();
  }
});

// Admin: Update order status
app.put('/api/v1/orders/:id/status', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, shippingStatus, paymentStatus } = req.body;

    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      params.push(status);
    }

    if (shippingStatus) {
      updates.push(`shipping_status = $${paramIndex++}`);
      params.push(shippingStatus);
    }

    if (paymentStatus) {
      updates.push(`payment_status = $${paramIndex++}`);
      params.push(paymentStatus);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_UPDATES', message: 'No fields to update' }
      });
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Order not found' }
      });
    }

    // Handle stock based on status
    if (status === 'cancelled') {
      const itemsResult = await pool.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
        [id]
      );

      for (const item of itemsResult.rows) {
        await pool.query(
          'UPDATE products SET reserved_stock = GREATEST(0, reserved_stock - $1), stock = stock - $1 WHERE id = $2',
          [item.quantity, item.product_id]
        );
      }
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update order' }
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
    await connectRabbitMQ();
    
    app.listen(PORT, () => {
      console.log(`🚀 Order Service running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start Order Service:', error);
    process.exit(1);
  }
}

start();
