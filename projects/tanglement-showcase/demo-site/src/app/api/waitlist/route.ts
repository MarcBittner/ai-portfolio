import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { sendWaitlistWelcomeEmail } from '@/lib/email/sendgrid';
import { subscribeToWaitlist } from '@/lib/email/convertkit';

/**
 * Waitlist Signup API Route
 *
 * POST /api/waitlist
 * Accepts email signups for the waitlist
 */

// Validation schema for waitlist signup
const waitlistSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  source: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Parse and validate request body
    const body = await request.json();
    const result = waitlistSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid email address',
          details: result.error.format(),
        },
        { status: 400 }
      );
    }

    const { email, source } = result.data;

    // Get user agent and referrer for analytics
    const userAgent = request.headers.get('user-agent') ?? undefined;
    const referrer = request.headers.get('referer') ?? undefined;

    // Create waitlist entry
    const entry = await prisma.waitlistEntry.create({
      data: {
        email,
        source,
        userAgent,
        referrer,
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
      },
    });

    // Get waitlist position for the welcome email
    const position = await prisma.waitlistEntry.count({
      where: {
        createdAt: {
          lte: entry.createdAt,
        },
      },
    });

    // Send welcome email (non-blocking, log errors but don't fail)
    sendWaitlistWelcomeEmail(email, position).catch((error) => {
      console.error('Failed to send welcome email:', error);
    });

    // Sync with ConvertKit (non-blocking)
    subscribeToWaitlist(email, { source }).then(async (result) => {
      if (result.success) {
        // Update entry with ConvertKit subscriber ID
        await prisma.waitlistEntry.update({
          where: { id: entry.id },
          data: { convertKitSubscriberId: String(result.data.id) },
        });
      } else {
        console.error('Failed to sync with ConvertKit:', result.error);
      }
    }).catch((error) => {
      console.error('ConvertKit sync error:', error);
    });

    return NextResponse.json(
      {
        success: true,
        message: 'Successfully joined the waitlist!',
        data: entry,
      },
      { status: 201 }
    );
  } catch (error) {
    // Handle duplicate email
    if (error instanceof PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return NextResponse.json(
          {
            success: false,
            error: 'This email is already on the waitlist',
          },
          { status: 409 }
        );
      }
    }

    // Log error for debugging
    console.error('Waitlist signup error:', error);

    // Generic error response
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to join waitlist. Please try again later.',
      },
      { status: 500 }
    );
  }
}

// Health check endpoint
export async function GET() {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;

    // Get waitlist stats
    const count = await prisma.waitlistEntry.count();

    return NextResponse.json({
      status: 'ok',
      totalSignups: count,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        error: 'Database connection failed',
      },
      { status: 503 }
    );
  }
}
