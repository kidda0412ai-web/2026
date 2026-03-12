// ============================================
// API Gateway - 主程式
// Port: 3000
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { createRedisClient } from './database/redis';
import { SERVICE_PORTS } from './constants';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.GATEWAY;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Rate Limiter
const rateLimiter = new RateLimiterMemory({
  points: 100,
  duration: 60
});

// ---------- Auth Middleware ----------
function verifyToken(req: Request, res: Response, next: NextFunction) {
  const publicPaths = ['/api/v1/auth/login', '/api/v1/auth/register', '/health'];
  
  if (publicPaths.includes(req.path)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: { code: 'NO_TOKEN', message: 'No token provided' } });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    (req as any).user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid token' } });
  }
}

// ---------- Rate Limiter Middleware ----------
async function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    await rateLimiter.consume(req.ip || 'unknown');
    next();
  } catch {
    res.status(429).json({ success: false, error: { code: 'RATE_LIMIT', message: 'Too many requests' } });
  }
}

// ---------- Service URLs ----------
const SERVICES = {
  auth: `http://localhost:${SERVICE_PORTS.AUTH}`,
  member: `http://localhost:${SERVICE_PORTS.MEMBER}`,
  product: `http://localhost:${SERVICE_PORTS.PRODUCT}`,
  order: `http://localhost:${SERVICE_PORTS.ORDER}`,
  payment: `http://localhost:${SERVICE_PORTS.PAYMENT}`,
  logistics: `http://localhost:${SERVICE_PORTS.LOGISTICS}`,
  notify: `http://localhost:${SERVICE_PORTS.NOTIFY}`,
};

// ---------- Proxy Configuration ----------
function createProxy(path: string, target: string) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: {
      [`^${path}`]: path
    },
    onProxyReq: (proxyReq, req) => {
      if ((req as any).user) {
        proxyReq.setHeader('X-User-ID', (req as any).user.userId);
        proxyReq.setHeader('X-User-Role', (req as any).user.role);
      }
    },
    onError: (err, req, res) => {
      console.error(`Proxy error for ${path}:`, err);
      res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' } });
    }
  });
}

// ---------- Routes ----------

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes
app.use('/api/v1/auth', verifyToken, rateLimiterMiddleware, createProxy('/api/v1/auth', SERVICES.auth));

// Member routes
app.use('/api/v1/member', verifyToken, rateLimiterMiddleware, createProxy('/api/v1/member', SERVICES.member));

// Product routes
app.use('/api/v1/products', rateLimiterMiddleware, createProxy('/api/v1/products', SERVICES.product));
app.use('/api/v1/categories', rateLimiterMiddleware, createProxy('/api/v1/categories', SERVICES.product));

// Order routes
app.use('/api/v1/orders', verifyToken, rateLimiterMiddleware, createProxy('/api/v1/orders', SERVICES.order));

// Payment routes
app.use('/api/v1/payments', verifyToken, rateLimiterMiddleware, createProxy('/api/v1/payments', SERVICES.payment));

// Logistics routes
app.use('/api/v1/logistics', verifyToken, rateLimiterMiddleware, createProxy('/api/v1/logistics', SERVICES.logistics));

// Notification routes
app.use('/api/v1/notifications', verifyToken, rateLimiterMiddleware, createProxy('/api/v1/notifications', SERVICES.notify));

// ---------- Error Handler ----------
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Gateway error:', err);
  res.status(500).json({ success: false, error: { code: 'GATEWAY_ERROR', message: 'Internal gateway error' } });
});

// ---------- Start Server ----------
async function start() {
  try {
    // Try to connect Redis (optional)
    try {
      await createRedisClient();
    } catch (e) {
      console.log('⚠️ Redis not connected, rate limiter will use memory');
    }

    app.listen(PORT, () => {
      console.log(`🚀 API Gateway running on port ${PORT}`);
      console.log(`📡 Forwarding to:`);
      console.log(`   Auth: ${SERVICES.auth}`);
      console.log(`   Member: ${SERVICES.member}`);
      console.log(`   Product: ${SERVICES.product}`);
      console.log(`   Order: ${SERVICES.order}`);
      console.log(`   Payment: ${SERVICES.payment}`);
      console.log(`   Logistics: ${SERVICES.logistics}`);
      console.log(`   Notify: ${SERVICES.notify}`);
    });
  } catch (error) {
    console.error('Failed to start Gateway:', error);
    process.exit(1);
  }
}

start();
