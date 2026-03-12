// ============================================
// 共用工具函數 - Proxy Shop
// ============================================

import { DEFAULT_FX_RATES } from '../constants';

// ---------- ID Generator ----------
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function generateOrderNumber(): string {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const random = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `PS${year}${month}${day}${random}`;
}

// ---------- Currency & FX ----------
export function convertToTWD(amount: number, currency: 'JPY' | 'KRW' | 'USD'): number {
  const rate = DEFAULT_FX_RATES[currency];
  return Math.round(amount * rate * 100) / 100;
}

export function formatCurrency(amount: number, currency: string = 'TWD'): string {
  const symbols: Record<string, string> = {
    TWD: 'NT$',
    USD: '$',
    JPY: '¥',
    KRW: '₩',
  };
  const symbol = symbols[currency] || currency;
  return `${symbol}${amount.toLocaleString()}`;
}

// ---------- Date ----------
export function formatDate(date: Date | string, format: 'full' | 'date' | 'time' = 'full'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  
  if (format === 'date') {
    return d.toLocaleDateString('zh-TW');
  }
  if (format === 'time') {
    return d.toLocaleTimeString('zh-TW');
  }
  return d.toLocaleString('zh-TW');
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function isExpired(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d < new Date();
}

// ---------- Validation ----------
export function isValidEmail(email: string): boolean {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

export function isValidPhone(phone: string): boolean {
  const regex = /^09\d{8}$/;
  return regex.test(phone);
}

export function isValidURL(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// ---------- Slug ----------
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------- Pagination ----------
export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function paginate<T>(data: T[], params: PaginationParams): PaginatedResult<T> {
  const page = params.page || 1;
  const limit = params.limit || 20;
  const start = (page - 1) * limit;
  const end = start + limit;
  
  return {
    data: data.slice(start, end),
    pagination: {
      page,
      limit,
      total: data.length,
      totalPages: Math.ceil(data.length / limit),
    },
  };
}

// ---------- Object ----------
export function omit<T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...obj };
  keys.forEach(key => delete result[key]);
  return result;
}

export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  keys.forEach(key => {
    if (key in obj) {
      result[key] = obj[key];
    }
  });
  return result;
}

// ---------- Hash (simple) ----------
export function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ---------- Price Calculation ----------
export function calculateTotal(
  subtotal: number,
  shippingFee: number,
  discount: number = 0,
  taxRate: number = 0
): number {
  const subtotalAfterDiscount = subtotal - discount;
  const tax = subtotalAfterDiscount * taxRate;
  return Math.round((subtotalAfterDiscount + shippingFee + tax) * 100) / 100;
}

export function calculateShippingFee(subtotal: number, freeThreshold: number = 499): number {
  return subtotal >= freeThreshold ? 0 : 60;
}
