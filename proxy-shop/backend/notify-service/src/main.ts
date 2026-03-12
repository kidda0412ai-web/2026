// ============================================
// Notification Service - 主程式
// Port: 3012
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { pool } from './database/postgres';
import { consumeMessages } from './database/rabbitmq';
import { verifyToken } from './middleware/auth';
import { SERVICE_PORTS } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.NOTIFY;

app.use(cors());
app.use(express.json());

// Email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        channel VARCHAR(20) DEFAULT 'email',
        status VARCHAR(20) DEFAULT 'pending',
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
    `);
    console.log('✅ Notify database initialized');
  } finally {
    client.release();
  }
}

// Send email
async function sendEmail(to: string, subject: string, html: string) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'noreply@proxy-shop.com',
      to,
      subject,
      html
    });
    console.log(`📧 Email sent to ${to}`);
  } catch (error) {
    console.error('Failed to send email:', error);
  }
}

// Process notification queue
async function processNotifications() {
  try {
    await consumeMessages('order_notifications', async (message: any) => {
      const { type, userId, data } = message;
      
      // Get user email
      const userResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length === 0) return;
      
      const user = userResult.rows[0];
      
      let title = '';
      let content = '';
      
      switch (type) {
        case 'order.created':
          title = '訂單已建立';
          content = `<p>親愛的 ${user.name}，您的訂單已建立，訂單編號：${data.orderNumber}。</p><p>總金額：NT$ ${data.total}</p>`;
          break;
        case 'order.paid':
          title = '付款成功';
          content = `<p>親愛的 ${user.name}，您的訂單已付款成功！</p><p>我們將盡快為您處理。</p>`;
          break;
        case 'order.shipped':
          title = '商品已出貨';
          content = `<p>親愛的 ${user.name}，您的訂單已出貨！</p><p>物流追蹤號：${data.trackingNumber}</p>`;
          break;
        case 'order.delivered':
          title = '商品已送達';
          content = `<p>親愛的 ${user.name}，您的訂單已送達！</p><p>感謝您的購買，歡迎再次光臨！</p>`;
          break;
        default:
          return;
      }

      // Save notification
      await pool.query(
        `INSERT INTO notifications (user_id, type, title, content, status, sent_at)
         VALUES ($1, $2, $3, $4, 'sent', NOW())`,
        [userId, type, title, content]
      );

      // Send email
      await sendEmail(user.email, title, `<html><body>${content}</body></html>`);
    });
  } catch (error) {
    console.error('Failed to process notifications:', error);
  }
}

// GET /api/v1/notifications - 取得通知列表
app.get('/api/v1/notifications', verifyToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { page = '1', limit = '20' } = req.query;

    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    
    const result = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1',
      [userId]
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: parseInt(countResult.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to get notifications' } });
  }
});

// PUT /api/v1/notifications/:id/read - 標記為已讀
app.put('/api/v1/notifications/:id/read', verifyToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user.userId;

    await pool.query(
      'UPDATE notifications SET status = $1 WHERE id = $2 AND user_id = $3',
      ['read', id, userId]
    );

    res.json({ success: true, data: { message: 'Marked as read' } });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to mark as read' } });
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function start() {
  try {
    await initDatabase();
    await processNotifications();
    app.listen(PORT, () => console.log(`🚀 Notify Service running on port ${PORT}`));
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
