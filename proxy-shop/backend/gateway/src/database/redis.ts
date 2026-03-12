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
