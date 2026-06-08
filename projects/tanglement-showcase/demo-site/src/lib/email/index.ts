/**
 * Email Services
 *
 * Centralized email functionality for transactional and marketing emails
 */

export {
  sendEmail,
  sendWaitlistWelcomeEmail,
  sendEmailVerification,
  type EmailOptions,
  type EmailResult,
} from './sendgrid';

export {
  convertkit,
  subscribeToWaitlist,
  type ConvertKitSubscriber,
  type ConvertKitResult,
} from './convertkit';
