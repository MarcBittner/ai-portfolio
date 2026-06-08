import { PrismaClient } from '@prisma/client';

/**
 * Prisma Client Singleton
 *
 * This ensures we only create one instance of PrismaClient in development
 * to avoid exhausting database connections during hot reloading.
 *
 * In production, we create a new client for each serverless function invocation.
 */

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const prismaClientSingleton = (): PrismaClient => {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });
};

const prisma = global.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

export default prisma;

/**
 * Database connection helper
 *
 * Checks if database is properly configured and connected
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

/**
 * Graceful shutdown
 *
 * Call this when shutting down the app to properly close database connections
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
