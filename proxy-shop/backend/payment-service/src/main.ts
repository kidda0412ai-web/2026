// ============================================
// Payment Service - 主程式
// Port: 3006
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { pool } from './database/postgres';
import { verifyToken } from './middleware/auth';
import { publishMessage } from './database/rabbitmq';
import { SERVICE_PORTS } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.PAYMENT;

app.use(cors());
app.use(express.json());

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL,
        user_id UUID NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'TWD',
        method VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        transaction_id VARCHAR(255),
        payment_data JSONB,
        paid_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_payments_order);
      CREATE INDEX ON payments(order_id IF NOT EXISTS idx_payments_user ON payments(user_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    `);
    console.log('✅ Payment database initialized');
  } finally {
    client.release();
  }
}

// POST /api/v1/payments - 建立支付
app.post('/api/v1/payments', verifyToken, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const userId = (req as any).user.userId;
    const { orderId, method } = req.body;

    if (!orderId || !method) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Order ID and method are required' }
      });
    }

    // Verify order exists and belongs to user
    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' }
      });
    }

    const order = orderResult.rows[0];

    // Check if already paid
    if (order.payment_status === 'paid') {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_PAID', message: 'Order already paid' }
      });
    }

    await client.query('BEGIN');

    // Create payment record
    const paymentResult = await client.query(
      `INSERT INTO payments (order_id, user_id, amount, method, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [orderId, userId, order.total, method]
    );

    const payment = paymentResult.rows[0];

    // Simulate payment processing (in real app, call payment gateway)
    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Update payment status
    await client.query(
      `UPDATE payments SET status = 'paid', transaction_id = $1, paid_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [transactionId, payment.id]
    );

    // Update order payment status
    await client.query(
      `UPDATE orders SET payment_status = 'paid', status = 'paid', updated_at = NOW()
       WHERE id = $1`,
      [orderId]
    );

    // Deduct stock
    const itemsResult = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [orderId]
    );

    for (const item of itemsResult.rows) {
      await client.query(
        'UPDATE products SET stock = stock - $1, reserved_stock = reserved_stock - $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    await client.query('COMMIT');

    // Publish payment success event
    try {
      await publishMessage('payment.success', {
        orderId,
        paymentId: payment.id,
        transactionId,
        amount: order.total
      });
    } catch (e) {
      console.error('Failed to publish payment success event:', e);
    }

    res.json({
      success: true,
      data: {
        paymentId: payment.id,
        transactionId,
        amount: order.total,
        status: 'paid'
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Payment error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Payment failed' }
    });
  } finally {
    client.release();
  }
});

// GET /api/v1/payments/:id - 取得支付資訊
app.get('/api/v1/payments/:id', verifyToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;

    const result = await pool.query(
      'SELECT * FROM payments WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Payment not found' }
      });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get payment' }
    });
  }
});

// POST /api/v1/payments/:id/refund - 退款
app.post('/api/v1/payments/:id/refund', verifyToken, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;

    await client.query('BEGIN');

    // Verify payment
    const paymentResult = await client.query(
      'SELECT * FROM payments WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (paymentResult.rows.length === 0) {
      throw new Error('NOT_FOUND');
    }

    const payment = paymentResult.rows[0];

    if (payment.status !== 'paid') {
      throw new Error('NOT_REFUNDABLE');
    }

    // Update payment status
    await client.query(
      `UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Update order status
    await client.query(
      `UPDATE orders SET payment_status = 'refunded', status = 'refunded', updated_at = NOW()
       WHERE id = $1`,
      [payment.order_id]
    );

    // Restore stock
    const itemsResult = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [payment.order_id]
    );

    for (const item of itemsResult.rows) {
      await client.query(
        'UPDATE products SET stock = stock + $1, reserved_stock = reserved_stock + $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    await client.query('COMMIT');

    res.json({ success: true, data: { message: 'Refund processed' } });
  } catch (error: any) {
    await client.query('ROLLBACK');
    
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Payment not found' }
      });
    }
    
    if (error.message === 'NOT_REFUNDABLE') {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_REFUNDABLE', message: 'Payment cannot be refunded' }
      });
    }

    console.error('Refund error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Refund failed' }
    });
  } finally {
    client.release();
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, () => console.log(`🚀 Payment Service running on port ${PORT}`));
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
