// ============================================
// Redis Connection
// ============================================

import { createClient, RedisClientType } from 'redis';

let client: RedisClientType | null = null;

export function createRedisClient(): RedisClientType {
  if (client) return client;

  client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  });

  client.on('error', (err) => {
    console.error('Redis error:', err);
  });

  client.on('connect', () => {
    console.log('✅ Redis connected');
  });

  return client;
}

export async function connectRedis(): Promise<RedisClientType> {
  const redisClient = createRedisClient();
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  return redisClient;
}

// ---------- Redis Helpers ----------

export async function cacheGet(key: string): Promise<string | null> {
  if (!client || !client.isOpen) return null;
  return client.get(key);
}

export async function cacheSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  if (!client || !client.isOpen) return;
  
  if (ttlSeconds) {
    await client.setEx(key, ttlSeconds, value);
  } else {
    await client.set(key, value);
  }
}

export async function cacheDelete(key: string): Promise<void> {
  if (!client || !client.isOpen) return;
  await client.del(key);
}

export async function cacheGetObject<T>(key: string): Promise<T | null> {
  const value = await cacheGet(key);
  if (!value) return null;
  return JSON.parse(value) as T;
}

export async function cacheSetObject<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
  await cacheSet(key, JSON.stringify(value), ttlSeconds);
}
