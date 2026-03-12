// ============================================
// 共用型別定義 - Proxy Shop
// ============================================

// ---------- User & Auth ----------
export interface User {
  id: string;
  email: string;
  name: string;
  phone?: string;
  role: 'user' | 'admin' | 'supplier';
  createdAt: Date;
  updatedAt: Date;
  emailVerified: boolean;
  status: 'active' | 'suspended' | 'deleted';
}

export interface UserProfile {
  userId: string;
  avatar?: string;
  bio?: string;
  address?: Address;
  customsInfo?: CustomsInfo;
}

export interface Address {
  id: string;
  userId: string;
  name: string;
  phone: string;
  country: string;
  city: string;
  district?: string;
  zipCode: string;
  detail: string;
  isDefault: boolean;
}

export interface CustomsInfo {
  realName: string;
  phone: string;
  idNumber?: string;  // 身份證字號（部分商品需要）
  ezwayNumber?: string;  // EZWAY 報關號碼
}

// ---------- OAuth ----------
export interface OAuthProvider {
  provider: 'google' | 'line' | 'facebook';
  providerId: string;
  userId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

// ---------- Product ----------
export interface Product {
  id: string;
  supplierId: string;
  name: string;
  description?: string;
  categoryId: string;
  images: string[];
  price: number;
  currency: 'JPY' | 'KRW' | 'USD' | 'TWD';
  originalPrice?: number;  // 原價
  stock: number;
  reservedStock: number;  // 預扣庫存
  status: 'active' | 'inactive' | 'outOfStock';
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductCategory {
  id: string;
  name: string;
  nameEn: string;
  parentId?: string;
  sortOrder: number;
  image?: string;
}

export interface CartItem {
  id: string;
  userId: string;
  productId: string;
  quantity: number;
  addedAt: Date;
}

// ---------- Order ----------
export interface Order {
  id: string;
  orderNumber: string;
  userId: string;
  items: OrderItem[];
  subtotal: number;
  shippingFee: number;
  tax: number;
  discount: number;
  total: number;
  currency: 'TWD';
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  shippingStatus: ShippingStatus;
  shippingAddress: Address;
  customsInfo: CustomsInfo;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  productImage: string;
  price: number;
  quantity: number;
  subtotal: number;
}

export type OrderStatus = 
  | 'pending'      // 待付款
  | 'paid'         // 已付款
  | 'processing'   // 處理中
  | 'shipped'      // 已出貨
  | 'delivered'    // 已送達
  | 'completed'    // 已完成
  | 'cancelled'    // 已取消
  | 'refunded';    // 已退款

export type PaymentStatus = 
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'partially_refunded';

export type ShippingStatus = 
  | 'not_shipped'
  | 'preparing'
  | 'shipped'
  | 'in_transit'
  | 'delivered'
  | 'failed';

// ---------- Payment ----------
export interface Payment {
  id: string;
  orderId: string;
  userId: string;
  amount: number;
  currency: 'TWD';
  method: 'credit_card' | 'line_pay' | 'jkopay' | 'bank_transfer';
  status: PaymentStatus;
  transactionId?: string;
  paidAt?: Date;
  createdAt: Date;
}

// ---------- Logistics ----------
export interface Logistics {
  id: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  status: ShippingStatus;
  events: LogisticsEvent[];
  estimatedDelivery?: Date;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface LogisticsEvent {
  time: Date;
  status: string;
  location?: string;
  description: string;
}

// ---------- Promotion ----------
export interface Promotion {
  id: string;
  code?: string;           // 折扣碼
  type: 'percentage' | 'fixed' | 'shipping';
  value: number;
  minPurchase?: number;
  maxDiscount?: number;
  startAt: Date;
  endAt: Date;
  usageLimit?: number;
  usageCount: number;
  status: 'active' | 'inactive' | 'expired';
}

// ---------- FX Rate ----------
export interface FxRate {
  from: 'JPY' | 'KRW' | 'USD';
  to: 'TWD';
  rate: number;
  updatedAt: Date;
}

// ---------- API Response ----------
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ---------- Auth ----------
export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  phone?: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}
