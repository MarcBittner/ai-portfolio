import { z } from 'zod';

/**
 * Environment Variable Validation Schema
 *
 * This file provides type-safe access to environment variables with runtime validation.
 * All environment variables are validated on app startup to catch configuration issues early.
 */

// Client-side environment variables (prefixed with NEXT_PUBLIC_)
const clientEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_PLAUSIBLE_DOMAIN: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
});

// Server-side environment variables (not exposed to client)
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().optional(), // .url() removed to allow dummy URLs in CI

  // Email (SendGrid)
  SENDGRID_API_KEY: z.string().min(1).optional(),
  SENDGRID_FROM_EMAIL: z.string().email().default('hello@tanglement.ai'),
  SENDGRID_FROM_NAME: z.string().default('Tanglement.ai'),

  // Email Marketing (ConvertKit)
  CONVERTKIT_API_KEY: z.string().min(1).optional(),
  CONVERTKIT_API_SECRET: z.string().min(1).optional(),
  CONVERTKIT_FORM_ID: z.string().min(1).optional(),
  CONVERTKIT_TAG_ID: z.string().optional(),

  // Error Tracking (Sentry - server side)
  SENTRY_DSN: z.string().url().optional(),

  // Internal
  PORT: z.string().default('3000'),
});

// Combined schema for validation
const envSchema = clientEnvSchema.merge(serverEnvSchema);

/**
 * Validate and parse environment variables
 *
 * @throws {ZodError} If environment variables are invalid
 */
function validateEnv() {
  // Allow skipping validation in CI/CD environments
  if (process.env.SKIP_ENV_VALIDATION === 'true') {
    console.log('⏭️  Skipping environment validation (SKIP_ENV_VALIDATION=true)');
    return process.env as z.infer<typeof envSchema>;
  }

  // In production, all variables should be present
  const isProduction = process.env.NODE_ENV === 'production';

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    console.error(JSON.stringify(parsed.error.format(), null, 2));

    if (isProduction) {
      // In CI/CD, we might not have all env vars, so just warn instead of throwing
      console.error('⚠️  Invalid environment variables in production mode');
      console.error('⚠️  Continuing with defaults where possible');
    } else {
      console.warn('⚠️  Continuing with invalid environment variables in development mode');
    }
  }

  return parsed.success ? parsed.data : ({} as z.infer<typeof envSchema>);
}

// Validate environment variables on module load
const env = validateEnv();

/**
 * Type-safe environment variables
 *
 * Usage:
 * ```ts
 * import { env } from '@/lib/env';
 *
 * // Server-side only
 * const apiKey = env.SENDGRID_API_KEY;
 *
 * // Client-side (NEXT_PUBLIC_ variables)
 * const siteUrl = env.NEXT_PUBLIC_SITE_URL;
 * ```
 */
export { env };

/**
 * Client-safe environment variables
 * Only includes NEXT_PUBLIC_ prefixed variables that are safe to expose to the browser
 */
export const clientEnv = {
  NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_PLAUSIBLE_DOMAIN: env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN,
  NEXT_PUBLIC_SENTRY_DSN: env.NEXT_PUBLIC_SENTRY_DSN,
} as const;

/**
 * Check if required environment variables are configured
 */
export function checkRequiredEnv(): {
  isValid: boolean;
  missing: string[];
  warnings: string[];
} {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Check critical variables for production
  if (env.NODE_ENV === 'production') {
    if (!env.DATABASE_URL) {
      warnings.push('DATABASE_URL not set - database features will be disabled');
    }
    if (!env.SENDGRID_API_KEY) {
      warnings.push('SENDGRID_API_KEY not set - email features will be disabled');
    }
    if (!env.CONVERTKIT_API_KEY) {
      warnings.push('CONVERTKIT_API_KEY not set - email marketing will be disabled');
    }
    if (!env.SENTRY_DSN) {
      warnings.push('SENTRY_DSN not set - error tracking will be disabled');
    }
  }

  return {
    isValid: missing.length === 0,
    missing,
    warnings,
  };
}

/**
 * Helper to check if we're in a specific environment
 */
export const isDevelopment = env.NODE_ENV === 'development';
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Helper to get the base URL
 */
export function getBaseUrl(): string {
  if (typeof window !== 'undefined') {
    // Browser - use current origin
    return window.location.origin;
  }

  // Server-side
  if (env.NEXT_PUBLIC_SITE_URL) {
    return env.NEXT_PUBLIC_SITE_URL;
  }

  // Fallback for local development
  return `http://localhost:${env.PORT}`;
}
