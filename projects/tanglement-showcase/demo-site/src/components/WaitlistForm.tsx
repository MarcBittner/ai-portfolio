'use client';

import * as React from 'react';
import { z } from 'zod';
import { Form, FormField, Button } from '@/components/ui';
import type { WaitlistSignupRequest, WaitlistSignupResponse, ApiResponse } from '@/types/api';

/**
 * Waitlist Form Component
 *
 * Email signup form for the waitlist with validation and API integration
 */

const waitlistSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

type WaitlistFormData = z.infer<typeof waitlistSchema>;

export interface WaitlistFormProps {
  /** Source identifier for analytics */
  source?: string;
  /** Callback on successful signup */
  onSuccess?: (data: WaitlistSignupResponse) => void;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Custom submit button text */
  submitText?: string;
  /** Show full-width button */
  fullWidth?: boolean;
}

export function WaitlistForm({
  source = 'hero',
  onSuccess,
  onError,
  submitText = 'Join Waitlist',
  fullWidth = false,
}: WaitlistFormProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isSuccess, setIsSuccess] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (data: WaitlistFormData) => {
    setIsSubmitting(true);
    setError(null);

    try {
      const payload: WaitlistSignupRequest = {
        email: data.email,
        source,
      };

      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const result = (await response.json()) as ApiResponse<WaitlistSignupResponse>;

      if (!response.ok || !result.success) {
        const errorMessage = result.success ? 'An error occurred' : result.error;
        setError(errorMessage);
        onError?.(errorMessage);
        return;
      }

      setIsSuccess(true);
      onSuccess?.(result.data);
    } catch (err) {
      const errorMessage = 'Network error. Please try again.';
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="rounded-lg bg-green-50 dark:bg-green-900/20 p-4 border border-green-200 dark:border-green-800">
        <p className="text-green-800 dark:text-green-200 font-medium">
          ✓ You&apos;re on the list!
        </p>
        <p className="text-green-700 dark:text-green-300 text-sm mt-1">
          Check your email for a confirmation message.
        </p>
      </div>
    );
  }

  return (
    <Form schema={waitlistSchema} onSubmit={handleSubmit}>
      <div className={fullWidth ? 'space-y-3' : 'flex gap-2 items-start'}>
        <div className={fullWidth ? 'w-full' : 'flex-1'}>
          <FormField
            name="email"
            type="email"
            placeholder="you@example.com"
            srOnlyLabel
            label="Email address"
            required
            disabled={isSubmitting}
          />
        </div>

        <Button
          type="submit"
          variant="primary"
          isLoading={isSubmitting}
          fullWidth={fullWidth}
          disabled={isSubmitting}
        >
          {submitText}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 border border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}
    </Form>
  );
}
