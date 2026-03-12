// ============================================
// Logistics Service - 主程式
// Port: 3011
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { pool } from './database/postgres';
import { verifyToken, requireRole } from './middleware/auth';
import { publishMessage } from './database/rabbitmq';
import { SERVICE_PORTS } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.LOGISTICS;

app.use(cors());
app.use(express.json());

// Carriers list
const CARRIERS = {
  '7-11': { name: '7-11 超商取貨', api: 'https://api.7-11.com.tw' },
  'family': { name: '全家超商取貨', api: 'https://api.family.com.tw' },
  'hilife': { name: '萊爾富', api: 'https://api.hilife.com.tw' },
  'ok': { name: 'OK 超商', api: 'https://api.ok-mart.com.tw' },
  'tcat': { name: '黑貓宅急便', api: 'https://tcat.com.tw' },
  'sendation': { name: '新竹物流', api: 'https://sendation.com.tw' },
};

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS logistics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL,
        carrier VARCHAR(50) NOT NULL,
        tracking_number VARCHAR(100),
        status VARCHAR(30) DEFAULT 'preparing',
        events JSONB DEFAULT '[]',
        estimated_delivery TIMESTAMP,
        delivered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_logistics_order ON logistics(order_id);
      CREATE INDEX IF NOT EXISTS idx_logistics_status ON logistics(status);
    `);
    console.log('✅ Logistics database initialized');
  } finally {
    client.release();
  }
}

// POST /api/v1/logistics - 建立物流
app.post('/api/v1/logistics', verifyToken, requireRole(['admin', 'supplier']), async (req: Request, res: Response) => {
  try {
    const { orderId, carrier } = req.body;

    if (!orderId || !carrier) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Order ID and carrier are required' }
      });
    }

    if (!CARRIERS[carrier]) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CARRIER', message: 'Invalid carrier' }
      });
    }

    // Check order exists
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
      });
    }

    // Generate tracking number (in real app, call carrier API)
    const trackingNumber = `${carrier.toUpperCase()}${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    const result = await pool.query(
      `INSERT INTO logistics (order_id, carrier, tracking_number, status)
       VALUES ($1, $2, $3, 'preparing')
       RETURNING *`,
      [orderId, carrier, trackingNumber]
    );

    // Update order shipping status
    await pool.query(
      `UPDATE orders SET shipping_status = 'preparing', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Create logistics error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create logistics' } });
  }
});

// GET /api/v1/logistics/:orderId - 取得物流資訊
app.get('/api/v1/logistics/:orderId', async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;

    const result = await pool.query(
      'SELECT * FROM logistics WHERE order_id = $1',
      [orderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Logistics not found' }
      });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get logistics error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get logistics' } });
  }
});

// PUT /api/v1/logistics/:id/status - 更新物流狀態
app.put('/api/v1/logistics/:id/status', verifyToken, requireRole(['admin']), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, location, description } = req.body;

    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      updates.push(`status = $${paramIndex++}`);
      params.push(status);
    }

    // Add event
    const event = {
      time: new Date().toISOString(),
      status: status || 'updated',
      location,
      description
    };

    updates.push(`events = events || $${paramIndex++}::jsonb`);
    params.push(JSON.stringify([event]));

    if (status === 'delivered') {
      updates.push(`delivered_at = NOW()`);
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE logistics SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Logistics not found' } });
    }

    // Update order shipping status
    if (status) {
      await pool.query(
        'UPDATE orders SET shipping_status = $1, updated_at = NOW() WHERE id = (SELECT order_id FROM logistics WHERE id = $2)',
        [status, id]
      );

      // Notify if delivered
      if (status === 'delivered') {
        try {
          const logistics = result.rows[0];
          await publishMessage('order.delivered', { orderId: logistics.order_id });
        } catch (e) {
          console.error('Failed to publish delivered event:', e);
        }
      }
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Update logistics error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update logistics' } });
  }
});

// Schedule: Track logistics every hour
cron.schedule('0 * * * *', async () => {
  console.log('🔄 Running logistics tracking...');
  
  try {
    const result = await pool.query(
      "SELECT * FROM logistics WHERE status NOT IN ('delivered', 'failed') AND tracking_number IS NOT NULL"
    );

    for (const log of result.rows) {
      // In real app, call carrier API to get tracking info
      // For demo, we'll simulate status updates
      
      if (log.status === 'preparing' && log.created_at < new Date(Date.now() - 3600000)) {
        await pool.query(
          "UPDATE logistics SET status = 'shipped', events = events || $1::jsonb, updated_at = NOW() WHERE id = $2",
          [JSON.stringify([{ time: new Date().toISOString(), status: 'shipped', description: '包裹已寄出' }]), log.id]
        );
      }
    }
  } catch (error) {
    console.error('Logistics tracking error:', error);
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, () => console.log(`🚀 Logistics Service running on port ${PORT}`));
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
