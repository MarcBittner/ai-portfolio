import sgMail from '@sendgrid/mail';
import { env } from '@/lib/env';

/**
 * SendGrid Email Client
 *
 * Handles transactional emails via SendGrid API
 */

// Initialize SendGrid with API key if available
if (env.SENDGRID_API_KEY) {
  sgMail.setApiKey(env.SENDGRID_API_KEY);
}

export type EmailOptions = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  templateId?: string;
  dynamicTemplateData?: Record<string, unknown>;
};

export type EmailResult = {
  success: true;
  messageId: string;
} | {
  success: false;
  error: string;
};

/**
 * Send an email via SendGrid
 */
export async function sendEmail(options: EmailOptions): Promise<EmailResult> {
  // Skip in test/development if no API key
  if (!env.SENDGRID_API_KEY) {
    console.warn('⚠️ SendGrid API key not configured, skipping email send');
    console.log('📧 Would send email:', {
      to: options.to,
      subject: options.subject,
    });
    return {
      success: true,
      messageId: 'dev-' + Date.now(),
    };
  }

  try {
    const msg: sgMail.MailDataRequired = {
      to: options.to,
      from: {
        email: env.SENDGRID_FROM_EMAIL,
        name: env.SENDGRID_FROM_NAME || 'Tanglement.ai',
      },
      subject: options.subject,
      html: options.html,
      text: options.text,
      // Use dynamic template if provided
      ...(options.templateId && {
        templateId: options.templateId,
        dynamicTemplateData: options.dynamicTemplateData,
      }),
    };

    const [response] = await sgMail.send(msg);

    return {
      success: true,
      messageId: response.headers['x-message-id'] || 'unknown',
    };
  } catch (error) {
    console.error('SendGrid send error:', error);

    const errorMessage = error instanceof Error
      ? error.message
      : 'Unknown error sending email';

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Send welcome email to new waitlist signup
 */
export async function sendWaitlistWelcomeEmail(
  email: string,
  position?: number
): Promise<EmailResult> {
  const subject = 'Welcome to Tanglement.ai!';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${subject}</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to Tanglement.ai</h1>
        </div>

        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
          <p style="font-size: 18px; margin-bottom: 20px;">Thanks for joining our waitlist!</p>

          <p>We're building something special, and we're excited to have you on board for the journey.</p>

          ${position ? `<p style="background: #f3f4f6; padding: 15px; border-radius: 5px; text-align: center; font-size: 16px;">
            <strong>You're #${position} on the waitlist</strong>
          </p>` : ''}

          <p>We'll keep you updated on our progress and let you know as soon as we're ready to launch.</p>

          <p style="margin-top: 30px;">Stay tuned!</p>

          <p style="color: #6366f1; font-weight: 600;">The Tanglement.ai Team</p>
        </div>

        <div style="text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px;">
          <p>You're receiving this email because you signed up for the Tanglement.ai waitlist.</p>
        </div>
      </body>
    </html>
  `;

  const text = `
Welcome to Tanglement.ai!

Thanks for joining our waitlist!

We're building something special, and we're excited to have you on board for the journey.

${position ? `You're #${position} on the waitlist.\n\n` : ''}

We'll keep you updated on our progress and let you know as soon as we're ready to launch.

Stay tuned!

The Tanglement.ai Team

---
You're receiving this email because you signed up for the Tanglement.ai waitlist.
  `.trim();

  return sendEmail({
    to: email,
    subject,
    html,
    text,
  });
}

/**
 * Send email verification email
 */
export async function sendEmailVerification(
  email: string,
  verificationUrl: string
): Promise<EmailResult> {
  const subject = 'Verify your email address';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${subject}</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-radius: 10px;">
          <h1 style="color: #6366f1; margin-top: 0;">Verify Your Email</h1>

          <p>Please verify your email address to complete your waitlist signup.</p>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" style="background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: 600;">
              Verify Email Address
            </a>
          </div>

          <p style="color: #6b7280; font-size: 14px;">Or copy and paste this link into your browser:</p>
          <p style="color: #6b7280; font-size: 14px; word-break: break-all;">${verificationUrl}</p>

          <p style="color: #6b7280; font-size: 14px; margin-top: 30px;">This link will expire in 24 hours.</p>
        </div>
      </body>
    </html>
  `;

  const text = `
Verify Your Email

Please verify your email address to complete your waitlist signup.

Click the link below to verify:
${verificationUrl}

This link will expire in 24 hours.

The Tanglement.ai Team
  `.trim();

  return sendEmail({
    to: email,
    subject,
    html,
    text,
  });
}
