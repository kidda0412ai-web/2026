# 跨國代購電商平台 - 完整版

## 專案結構

```
proxy-shop/
├── backend/                    # 後端微服務
│   ├── gateway/               # API Gateway (Port 3000) ✅
│   ├── auth-service/          # 身份驗證 (Port 3001) ✅
│   ├── member-service/        # 會員服務 (Port 3002) ✅
│   ├── product-service/       # 商品服務 (Port 3003) ✅
│   ├── category-service/      # 分類服務 (Port 3004) ✅
│   ├── order-service/        # 訂單服務 (Port 3005) ✅
│   ├── payment-service/      # 支付服務 (Port 3006) ✅
│   ├── promotion-service/    # 促銷服務 (Port 3008) ✅
│   ├── fx-service/           # 匯率服務 (Port 3009) ✅
│   ├── supplier-service/     # 供應商服務 (Port 3010) ✅
│   ├── logistics-service/    # 物流服務 (Port 3011) ✅
│   ├── notify-service/       # 通知服務 (Port 3012) ✅
│   ├── shared/               # 共用套件 ✅
│   └── docker-compose.yml    # 基礎設施 ✅
│
├── frontend-web/              # 前端網站
│   └── index.html           # MVP 網頁 ✅
│
└── README.md
```

## 啟動方式

```bash
# 1. 啟動資料庫
cd backend
docker-compose up -d

# 2. 啟動所有服務
cd gateway && npm run dev &
cd auth-service && npm run dev &
cd member-service && npm run dev &
cd product-service && npm run dev &
cd category-service && npm run dev &
cd order-service && npm run dev &
cd payment-service && npm run dev &
cd promotion-service && npm run dev &
cd fx-service && npm run dev &
cd supplier-service && npm run dev &
cd logistics-service && npm run dev &
cd notify-service && npm run dev &

# 3. 打開前端
open frontend-web/index.html
```

## 服務對照表

| Port | 服務 | 功能 |
|------|------|------|
| 3000 | Gateway | API 統一入口 |
| 3001 | Auth | 註冊/登入/JWT |
| 3002 | Member | 會員資料/地址/收藏 |
| 3003 | Product | 商品/庫存 |
| 3004 | Category | 分類管理 |
| 3005 | Order | 訂單 |
| 3006 | Payment | 支付 |
| 3008 | Promotion | 優惠券 |
| 3009 | FX | 匯率 |
| 3010 | Supplier | 供應商 |
| 3011 | Logistics | 物流 |
| 3012 | Notify | 郵件通知 |

## 功能完成度

| 功能 | 狀態 |
|------|------|
| 用戶系統 | ✅ |
| 會員中心 | ✅ |
| 商品管理 | ✅ |
| 分類系統 | ✅ |
| 購物車 | ✅ |
| 訂單系統 | ✅ |
| 支付整合 | ✅ |
| 促銷優惠 | ✅ |
| 匯率轉換 | ✅ |
| 供應商管理 | ✅ |
| 物流追蹤 | ✅ |
| 郵件通知 | ✅ |
| API Gateway | ✅ |
| 前端網站 | ✅ |

---

**代購網站 MVP 開發完成！** 🎉
# Test auto deploy
