// ============================================
// FX Rate Service - 主程式
// Port: 3009
// ============================================

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import axios from 'axios';
import { pool } from './database/postgres';
import { cacheGetObject, cacheSetObject } from './database/redis';
import { SERVICE_PORTS, DEFAULT_FX_RATES, CACHE_TTL } from '@proxy-shop/shared';

dotenv.config();

const app = express();
const PORT = SERVICE_PORTS.FX;

app.use(cors());
app.use(express.json());

// Default rates (fallback)
let currentRates = { ...DEFAULT_FX_RATES };

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fx_rates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_currency VARCHAR(10) NOT NULL,
        to_currency VARCHAR(10) NOT NULL,
        rate DECIMAL(10,6) NOT NULL,
        source VARCHAR(50) DEFAULT 'manual',
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(from_currency, to_currency)
      );
    `);
    console.log('✅ FX database initialized');
    
    // Load rates from DB
    await loadRatesFromDB();
  } finally { client.release(); }
}

async function loadRatesFromDB() {
  try {
    const result = await pool.query('SELECT from_currency, to_currency, rate FROM fx_rates WHERE to_currency = $1', ['TWD']);
    const rates: Record<string, number> = {};
    result.rows.forEach(r => { rates[r.from_currency] = parseFloat(r.rate); });
    if (Object.keys(rates).length > 0) {
      currentRates = rates;
    }
  } catch (e) { console.error('Failed to load rates from DB:', e); }
}

// Fetch rates from external API (example)
async function fetchRatesFromAPI() {
  try {
    // Example: using exchangeRate-api or similar free API
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
    const rates = response.data.rates;
    
    const twdRates = {
      JPY: rates.JPY / rates.TWD,
      KRW: rates.KRW / rates.TWD,
      USD: 1 / rates.TWD
    };
    
    // Save to DB
    for (const [currency, rate] of Object.entries(twdRates)) {
      await pool.query(
        `INSERT INTO fx_rates (from_currency, to_currency, rate, source) VALUES ($1, $2, $3, 'api')
         ON CONFLICT (from_currency, to_currency) DO UPDATE SET rate = $3, fetched_at = NOW(), source = 'api'`,
        [currency, 'TWD', rate]
      );
    }
    
    currentRates = twdRates;
    console.log('✅ FX rates updated from API');
  } catch (e) {
    console.error('Failed to fetch rates from API:', e);
  }
}

// Schedule: Update rates every hour
cron.schedule('0 * * * *', async () => {
  console.log('🔄 Updating FX rates...');
  await fetchRatesFromAPI();
});

// GET /api/v1/fx/rates - 取得匯率
app.get('/api/v1/fx/rates', async (req: Request, res: Response) => {
  try {
    const cacheKey = 'fx:rates';
    const cached = await cacheGetObject(cacheKey);
    if (cached) return res.json({ success: true, data: cached });

    const result = await pool.query('SELECT * FROM fx_rates ORDER BY from_currency');
    const rates = result.rows.length > 0 ? result.rows : Object.entries(currentRates).map(([from, rate]) => ({ from_currency: from, to_currency: 'TWD', rate }));
    
    await cacheSetObject(cacheKey, rates, CACHE_TTL.FX_RATE);
    res.json({ success: true, data: rates });
  } catch (error) {
    res.json({ success: true, data: Object.entries(currentRates).map(([from, rate]) => ({ from_currency: from, to_currency: 'TWD', rate })) });
  }
});

// GET /api/v1/fx/convert - 換算匯率
app.get('/api/v1/fx/convert', async (req: Request, res: Response) => {
  try {
    const { amount, from, to } = req.query;
    if (!amount || !from || !to) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Amount, from, and to are required' } });
    }

    let rate: number;
    if (from === to) {
      rate = 1;
    } else if (to === 'TWD') {
      rate = currentRates[from as string] || DEFAULT_FX_RATES[from as keyof typeof DEFAULT_FX_RATES];
    } else if (from === 'TWD') {
      rate = 1 / (currentRates[to as string] || DEFAULT_FX_RATES[to as keyof typeof DEFAULT_FX_RATES]);
    } else {
      const fromToTWD = currentRates[from as string] || DEFAULT_FX_RATES[from as keyof typeof DEFAULT_FX_RATES];
      const toToTWD = currentRates[to as string] || DEFAULT_FX_RATES[to as keyof typeof DEFAULT_FX_RATES];
      rate = fromToTWD / toToTWD;
    }

    const result = parseFloat(amount as string) * rate;
    res.json({ success: true, data: { amount: parseFloat(amount as string), from, to, rate, result: Math.round(result * 100) / 100 } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Conversion failed' } });
  }
});

// POST /api/v1/fx/rates - 手動更新匯率 (Admin)
app.post('/api/v1/fx/rates', async (req: Request, res: Response) => {
  try {
    const { from, to, rate } = req.body;
    if (!from || !to || !rate) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'From, to, and rate are required' } });
    }

    await pool.query(
      `INSERT INTO fx_rates (from_currency, to_currency, rate, source) VALUES ($1, $2, $3, 'manual')
       ON CONFLICT (from_currency, to_currency) DO UPDATE SET rate = $3, fetched_at = NOW(), source = 'manual'`,
      [from, to, rate]
    );

    currentRates[from] = rate;
    res.json({ success: true, data: { from, to, rate } });
  } catch (error) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update rate' } });
  }
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

async function start() {
  try {
    await initDatabase();
    await fetchRatesFromAPI();
    app.listen(PORT, () => console.log(`🚀 FX Service running on port ${PORT}`));
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}
start();
