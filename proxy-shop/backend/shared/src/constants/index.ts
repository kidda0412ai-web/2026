// ============================================
// 共用常數 - Proxy Shop
// ============================================

// ---------- API ----------
export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

// ---------- Ports ----------
export const SERVICE_PORTS = {
  AUTH: 3001,
  MEMBER: 3002,
  PRODUCT: 3003,
  CATEGORY: 3004,
  ORDER: 3005,
  PAYMENT: 3006,
  INVOICE: 3007,
  PROMOTION: 3008,
  FX: 3009,
  SUPPLIER: 3010,
  LOGISTICS: 3011,
  NOTIFY: 3012,
  GATEWAY: 3000,
};

// ---------- JWT ----------
export const JWT_EXPIRY = '7d';
export const REFRESH_TOKEN_EXPIRY = '30d';

// ---------- Rate Limiting ----------
export const RATE_LIMIT = {
  DEFAULT: 100,      // 100 requests per minute
  AUTH: 10,          // 10 requests per minute for auth endpoints
  API: 60,           // 60 requests per minute for general API
};

// ---------- Pagination ----------
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
};

// ---------- Order Status ----------
export const ORDER_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
} as const;

// ---------- Payment Methods ----------
export const PAYMENT_METHODS = {
  CREDIT_CARD: 'credit_card',
  LINE_PAY: 'line_pay',
  JKOPAY: 'jkopay',
  BANK_TRANSFER: 'bank_transfer',
} as const;

// ---------- Currency ----------
export const CURRENCIES = {
  JPY: { code: 'JPY', symbol: '¥', name: '日圓' },
  KRW: { code: 'KRW', symbol: '₩', name: '韓圓' },
  USD: { code: 'USD', symbol: '$', name: '美元' },
  TWD: { code: 'TWD', symbol: 'NT$', name: '台幣' },
} as const;

// ---------- Default FX Rates (should be fetched from API) ----------
export const DEFAULT_FX_RATES = {
  JPY: 0.22,   // 1 JPY = 0.22 TWD
  KRW: 0.024,  // 1 KRW = 0.024 TWD
  USD: 32.0,   // 1 USD = 32 TWD
};

// ---------- Shipping ----------
export const SHIPPING_FEE = {
  TWD: 60,     // 基本運費
  FREE_THRESHOLD: 499,  // 滿額免運
};

// ---------- File Upload ----------
export const UPLOAD_CONFIG = {
  MAX_FILE_SIZE: 10 * 1024 * 1024,  // 10MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  MAX_IMAGES_PER_PRODUCT: 10,
};

// ---------- Cache TTL (seconds) ----------
export const CACHE_TTL = {
  PRODUCT: 300,        // 5 minutes
  CATEGORY: 3600,      // 1 hour
  FX_RATE: 300,        // 5 minutes
  USER_SESSION: 1800,  // 30 minutes
};
