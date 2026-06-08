import { env } from '@/lib/env';

/**
 * ConvertKit Email Marketing Client
 *
 * Handles email list management and marketing automation
 * Docs: https://developers.convertkit.com/
 */

export type ConvertKitSubscriber = {
  id: number;
  email: string;
  state: 'active' | 'inactive' | 'cancelled' | 'bounced' | 'complained';
  created_at: string;
  fields?: Record<string, string>;
  tags?: { id: number; name: string }[];
};

export type ConvertKitResult<T = unknown> = {
  success: true;
  data: T;
} | {
  success: false;
  error: string;
};

/**
 * ConvertKit API client
 */
class ConvertKitClient {
  private baseUrl = 'https://api.convertkit.com/v3';
  private apiKey: string | undefined;
  private apiSecret: string | undefined;
  private formId: string | undefined;
  private tagId: string | undefined;

  constructor() {
    this.apiKey = env.CONVERTKIT_API_KEY;
    this.apiSecret = env.CONVERTKIT_API_SECRET;
    this.formId = env.CONVERTKIT_FORM_ID;
    this.tagId = env.CONVERTKIT_TAG_ID;
  }

  /**
   * Check if ConvertKit is configured
   */
  isConfigured(): boolean {
    return !!(this.apiKey && this.formId);
  }

  /**
   * Subscribe an email to the waitlist form
   */
  async subscribe(
    email: string,
    options?: {
      firstName?: string;
      fields?: Record<string, string>;
      tags?: number[];
    }
  ): Promise<ConvertKitResult<ConvertKitSubscriber>> {
    if (!this.isConfigured()) {
      console.warn('⚠️ ConvertKit not configured, skipping subscription');
      return {
        success: true,
        data: {
          id: 0,
          email,
          state: 'active',
          created_at: new Date().toISOString(),
        },
      };
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/forms/${this.formId}/subscribe`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            api_key: this.apiKey,
            email,
            first_name: options?.firstName,
            fields: options?.fields,
            tags: options?.tags || (this.tagId ? [parseInt(this.tagId)] : undefined),
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ConvertKit API error: ${error}`);
      }

      const data = await response.json() as { subscription: ConvertKitSubscriber };

      return {
        success: true,
        data: data.subscription,
      };
    } catch (error) {
      console.error('ConvertKit subscription error:', error);

      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error subscribing to ConvertKit';

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Add tags to a subscriber
   */
  async tagSubscriber(
    email: string,
    tagIds: number[]
  ): Promise<ConvertKitResult<void>> {
    if (!this.isConfigured() || !this.apiSecret) {
      console.warn('⚠️ ConvertKit API secret not configured, skipping tagging');
      return { success: true, data: undefined };
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/tags/${tagIds[0]}/subscribe`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            api_secret: this.apiSecret,
            email,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ConvertKit API error: ${error}`);
      }

      return { success: true, data: undefined };
    } catch (error) {
      console.error('ConvertKit tagging error:', error);

      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error tagging subscriber';

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Update subscriber custom fields
   */
  async updateSubscriberFields(
    subscriberId: number,
    fields: Record<string, string>
  ): Promise<ConvertKitResult<void>> {
    if (!this.isConfigured() || !this.apiSecret) {
      console.warn('⚠️ ConvertKit API secret not configured, skipping field update');
      return { success: true, data: undefined };
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/subscribers/${subscriberId}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            api_secret: this.apiSecret,
            fields,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ConvertKit API error: ${error}`);
      }

      return { success: true, data: undefined };
    } catch (error) {
      console.error('ConvertKit field update error:', error);

      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error updating subscriber fields';

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Get subscriber by email
   */
  async getSubscriber(
    email: string
  ): Promise<ConvertKitResult<ConvertKitSubscriber[]>> {
    if (!this.isConfigured() || !this.apiSecret) {
      console.warn('⚠️ ConvertKit API secret not configured');
      return {
        success: false,
        error: 'ConvertKit not configured',
      };
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/subscribers?api_secret=${this.apiSecret}&email_address=${encodeURIComponent(email)}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ConvertKit API error: ${error}`);
      }

      const data = await response.json() as { subscribers: ConvertKitSubscriber[] };

      return {
        success: true,
        data: data.subscribers,
      };
    } catch (error) {
      console.error('ConvertKit get subscriber error:', error);

      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error fetching subscriber';

      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}

// Export singleton instance
export const convertkit = new ConvertKitClient();

/**
 * Subscribe email to waitlist with ConvertKit
 */
export async function subscribeToWaitlist(
  email: string,
  options?: {
    source?: string;
  }
): Promise<ConvertKitResult<ConvertKitSubscriber>> {
  return convertkit.subscribe(email, {
    fields: {
      signup_source: options?.source || 'website',
      signup_date: new Date().toISOString(),
    },
  });
}
