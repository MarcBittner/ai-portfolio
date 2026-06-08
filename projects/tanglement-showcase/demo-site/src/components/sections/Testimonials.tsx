'use client';

import * as React from 'react';
import { Section, Container, Grid } from '@/components/layout';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

/**
 * Testimonials Component
 *
 * Display customer testimonials with ratings, avatars, and flexible layouts
 */

export interface Testimonial {
  /** Testimonial content */
  quote: string;
  /** Person's name */
  name: string;
  /** Person's role/title */
  role: string;
  /** Company name */
  company: string;
  /** Avatar URL (optional) */
  avatar?: string;
  /** Star rating (1-5) */
  rating?: number;
}

const testimonialVariants = cva(
  'rounded-xl p-8 transition-all duration-500 hover:-translate-y-1',
  {
    variants: {
      variant: {
        default: 'bg-white border border-gray-200 shadow-md hover:shadow-xl hover:shadow-brand-accent/10 hover:border-brand-accent/30',
        compact: 'bg-gray-50 border border-gray-100 hover:bg-white hover:shadow-lg',
        dark: 'bg-gray-900 border border-gray-800 text-white hover:border-brand-accent/50 hover:shadow-xl hover:shadow-brand-accent/20',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface TestimonialsProps extends VariantProps<typeof testimonialVariants> {
  /** Section title */
  title?: string;
  /** Section subtitle */
  subtitle?: string;
  /** Array of testimonials */
  testimonials?: Testimonial[];
  /** Number of columns (2 or 3) */
  columns?: 2 | 3;
  /** Custom className */
  className?: string;
}

const defaultTestimonials: Testimonial[] = [
  {
    quote:
      "Tanglement.ai reduced our LLM costs by 38% in the first month. The automatic failover saved us during the OpenAI outage last week. It's like having insurance for your AI infrastructure.",
    name: 'Sarah Chen',
    role: 'CTO',
    company: 'TechFlow AI',
    rating: 5,
  },
  {
    quote:
      'The client-side routing is brilliant. Our API keys never leave our infrastructure, and we can switch providers without changing a single line of code. True vendor independence.',
    name: 'Michael Rodriguez',
    role: 'Lead Engineer',
    company: 'DataStream Inc',
    rating: 5,
  },
  {
    quote:
      "We've been in the private alpha for three months. The cost savings are real, but the reliability is what keeps us here. 99.9% uptime isn't marketing—it's reality.",
    name: 'Priya Patel',
    role: 'VP of Engineering',
    company: 'CloudNative Systems',
    rating: 5,
  },
  {
    quote:
      'Finally, a solution that treats LLM access like the critical infrastructure it is. Multi-provider routing, automatic failover, and cost optimization in one elegant package.',
    name: 'James Wilson',
    role: 'Principal Architect',
    company: 'Enterprise AI Solutions',
    rating: 5,
  },
  {
    quote:
      'The decentralized architecture gives us peace of mind. No single point of failure, no vendor lock-in, and our data stays private. This is how AI infrastructure should be built.',
    name: 'Lisa Zhang',
    role: 'Director of AI',
    company: 'FinTech Innovations',
    rating: 5,
  },
  {
    quote:
      "Tanglement.ai's intelligent routing saved us $45K in the first quarter. The ROI was immediate, and the setup took less than an hour. Best infrastructure decision we made this year.",
    name: 'David Kim',
    role: 'Co-Founder',
    company: 'StartupAI',
    rating: 5,
  },
];

function StarRating({ rating = 5 }: { rating?: number }) {
  return (
    <div className="flex gap-1" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <svg
          key={i}
          className={cn(
            'h-5 w-5',
            i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300 fill-gray-300'
          )}
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

function TestimonialCard({
  testimonial,
  variant,
}: {
  testimonial: Testimonial;
  variant?: 'default' | 'compact' | 'dark';
}) {
  return (
    <div className={testimonialVariants({ variant })}>
      {/* Rating */}
      {testimonial.rating && (
        <div className="mb-4">
          <StarRating rating={testimonial.rating} />
        </div>
      )}

      {/* Quote */}
      <blockquote
        className={cn(
          'mb-6 text-base leading-relaxed',
          variant === 'dark' ? 'text-gray-100' : 'text-gray-700'
        )}
      >
        "{testimonial.quote}"
      </blockquote>

      {/* Author Info */}
      <div className="flex items-center gap-4">
        {/* Avatar */}
        <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-brand-primary to-brand-secondary">
          {testimonial.avatar ? (
            <img
              src={testimonial.avatar}
              alt={testimonial.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-lg font-bold text-white">
              {testimonial.name
                .split(' ')
                .map((n) => n[0])
                .join('')
                .toUpperCase()}
            </div>
          )}
        </div>

        {/* Name and Role */}
        <div className="flex-1">
          <div
            className={cn(
              'font-semibold',
              variant === 'dark' ? 'text-white' : 'text-gray-900'
            )}
          >
            {testimonial.name}
          </div>
          <div
            className={cn(
              'text-sm',
              variant === 'dark' ? 'text-gray-400' : 'text-gray-600'
            )}
          >
            {testimonial.role} at {testimonial.company}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Testimonials({
  title = 'Trusted by Forward-Thinking Teams',
  subtitle = 'What Our Users Say',
  testimonials = defaultTestimonials,
  columns = 3,
  variant = 'default',
  className,
}: TestimonialsProps) {
  const displayedTestimonials = testimonials.slice(0, columns === 3 ? 6 : 4);

  return (
    <Section
      spacing="xl"
      variant={variant === 'dark' ? 'dark' : 'default'}
      className={cn('overflow-hidden', className)}
    >
      <Container>
        {/* Header */}
        <div className="mb-16 text-center">
          <p
            className={cn(
              'mb-3 text-sm font-semibold uppercase tracking-wider',
              variant === 'dark' ? 'text-brand-accent' : 'text-accent'
            )}
          >
            {subtitle}
          </p>
          <h2
            className={cn(
              'text-4xl font-bold',
              variant === 'dark' ? 'text-white' : 'text-gray-900'
            )}
          >
            {title}
          </h2>
        </div>

        {/* Testimonials Grid */}
        <Grid cols={columns === 3 ? 3 : 2} gap="lg" className="mb-8">
          {displayedTestimonials.map((testimonial, index) => (
            <div
              key={index}
              className="col-span-1 animate-slide-up"
              style={{ animationDelay: `${index * 150}ms` }}
            >
              <TestimonialCard testimonial={testimonial} variant={variant ?? undefined} />
            </div>
          ))}
        </Grid>

        {/* Optional CTA */}
        <div className="mt-12 text-center">
          <p
            className={cn(
              'text-sm',
              variant === 'dark' ? 'text-gray-400' : 'text-gray-600'
            )}
          >
            Join the waitlist to experience these benefits yourself
          </p>
        </div>
      </Container>
    </Section>
  );
}
