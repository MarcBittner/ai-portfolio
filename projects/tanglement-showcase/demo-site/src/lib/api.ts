import { NextResponse } from 'next/server';

/**
 * API Utilities
 *
 * Helper functions for consistent API responses and error handling
 */

export type ApiSuccessResponse<T = unknown> = {
  success: true;
  message?: string;
  data: T;
};

export type ApiErrorResponse = {
  success: false;
  error: string;
  details?: unknown;
};

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Create a successful API response
 */
export function apiSuccess<T>(
  data: T,
  message?: string,
  status: number = 200
): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json(
    {
      success: true,
      message,
      data,
    },
    { status }
  );
}

/**
 * Create an error API response
 */
export function apiError(
  error: string,
  status: number = 500,
  details?: unknown
): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    {
      success: false,
      error,
      details,
    },
    { status }
  );
}

/**
 * Common API error responses
 */
export const ApiErrors = {
  badRequest: (message = 'Invalid request') => apiError(message, 400),
  unauthorized: (message = 'Unauthorized') => apiError(message, 401),
  forbidden: (message = 'Forbidden') => apiError(message, 403),
  notFound: (message = 'Not found') => apiError(message, 404),
  conflict: (message = 'Conflict') => apiError(message, 409),
  rateLimit: (message = 'Too many requests') => apiError(message, 429),
  internal: (message = 'Internal server error') => apiError(message, 500),
  serviceUnavailable: (message = 'Service unavailable') => apiError(message, 503),
} as const;

/**
 * Parse and validate request body
 */
export async function parseRequestBody<T>(
  request: Request
): Promise<{ success: true; data: T } | { success: false; error: NextResponse }> {
  try {
    const body = (await request.json()) as T;
    return { success: true, data: body };
  } catch {
    return {
      success: false,
      error: apiError('Invalid JSON in request body', 400),
    };
  }
}

/**
 * Get client IP address from request
 */
export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');

  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? null;
  }

  return realIp;
}

/**
 * Simple in-memory rate limiter
 * For production, use Redis or a dedicated rate limiting service
 */
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private windowMs: number;
  private maxRequests: number;

  constructor(windowMs: number = 60000, maxRequests: number = 10) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;

    // Clean up old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  check(identifier: string): boolean {
    const now = Date.now();
    const requests = this.requests.get(identifier) ?? [];

    // Remove old requests outside the window
    const validRequests = requests.filter((time) => now - time < this.windowMs);

    if (validRequests.length >= this.maxRequests) {
      return false;
    }

    validRequests.push(now);
    this.requests.set(identifier, validRequests);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, requests] of this.requests.entries()) {
      const validRequests = requests.filter((time) => now - time < this.windowMs);
      if (validRequests.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, validRequests);
      }
    }
  }
}

// Global rate limiter instance (10 requests per minute)
export const rateLimiter = new RateLimiter(60000, 10);

/**
 * Rate limiting middleware
 *
 * Usage:
 * ```ts
 * export async function POST(request: Request) {
 *   const rateLimitCheck = checkRateLimit(request);
 *   if (!rateLimitCheck.allowed) {
 *     return rateLimitCheck.response;
 *   }
 *   // ... handle request
 * }
 * ```
 */
export function checkRateLimit(
  request: Request
): { allowed: true } | { allowed: false; response: NextResponse } {
  const ip = getClientIp(request) ?? 'unknown';
  const allowed = rateLimiter.check(ip);

  if (!allowed) {
    return {
      allowed: false,
      response: ApiErrors.rateLimit('Too many requests. Please try again later.'),
    };
  }

  return { allowed: true };
}
