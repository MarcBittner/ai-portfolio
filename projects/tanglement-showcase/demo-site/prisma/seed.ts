import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Clear existing data in development
  if (process.env.NODE_ENV === 'development') {
    console.log('🗑️  Clearing existing data...');
    await prisma.waitlistEntry.deleteMany({});
  }

  // Seed waitlist entries for testing
  console.log('📧 Creating sample waitlist entries...');

  const waitlistEntries = await Promise.all([
    prisma.waitlistEntry.create({
      data: {
        email: 'alice@example.com',
        source: 'hero',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    }),
    prisma.waitlistEntry.create({
      data: {
        email: 'bob@example.com',
        source: 'footer',
        emailVerified: false,
      },
    }),
    prisma.waitlistEntry.create({
      data: {
        email: 'charlie@example.com',
        source: 'modal',
        emailVerified: true,
        emailVerifiedAt: new Date(),
        metadata: {
          interests: ['AI', 'blockchain'],
          company: 'Tech Startup Inc',
        },
      },
    }),
  ]);

  console.log(`✅ Created ${waitlistEntries.length} waitlist entries`);
  console.log('🌱 Seeding completed!');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('❌ Seeding failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
