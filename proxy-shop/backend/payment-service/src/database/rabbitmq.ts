// ============================================
// RabbitMQ Connection
// ============================================

import amqp, { Channel, Connection } from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

let connection: Connection | null = null;
let channel: Channel | null = null;

export async function connectRabbitMQ(): Promise<Channel> {
  if (channel) return channel;

  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    
    // Declare exchanges
    await channel.assertExchange('orders', 'topic', { durable: true });
    
    // Declare queues
    await channel.assertQueue('order_notifications', { durable: true });
    await channel.assertQueue('stock_updates', { durable: true });
    
    // Bind queues
    await channel.bindQueue('order_notifications', 'orders', 'order.*');
    await channel.bindQueue('stock_updates', 'orders', 'order.created');
    
    console.log('✅ RabbitMQ connected');
    return channel;
  } catch (error) {
    console.error('Failed to connect to RabbitMQ:', error);
    throw error;
  }
}

export async function publishMessage(routingKey: string, message: any): Promise<void> {
  if (!channel) {
    await connectRabbitMQ();
  }
  
  channel!.publish(
    'orders',
    routingKey,
    Buffer.from(JSON.stringify(message)),
    { persistent: true }
  );
  
  console.log(`📨 Published message: ${routingKey}`);
}

export async function consumeMessages(queue: string, callback: (message: any) => void): Promise<void> {
  if (!channel) {
    await connectRabbitMQ();
  }
  
  await channel!.consume(queue, (msg) => {
    if (msg) {
      const content = JSON.parse(msg.content.toString());
      callback(content);
      channel!.ack(msg);
    }
  });
}

export async function closeRabbitMQ(): Promise<void> {
  if (channel) await channel.close();
  if (connection) await connection.close();
}
