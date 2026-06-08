'use client';

import * as React from 'react';
import { Section, Container, Grid } from '@/components/layout';
import { cn } from '@/lib/utils';
import { useMouseFollow } from '@/hooks/useScrollAnimation';

/**
 * Features Section Component
 *
 * Display product features in a grid layout
 */

export interface Feature {
  /** Feature icon (React component or emoji) */
  icon?: React.ReactNode;
  /** Feature title */
  title: string;
  /** Feature description */
  description: string;
  /** Optional link */
  href?: string;
}

export interface FeaturesProps {
  /** Section title */
  title?: string;
  /** Section subtitle */
  subtitle?: string;
  /** Features to display */
  features: Feature[];
  /** Number of columns */
  columns?: 2 | 3 | 4;
  /** Section variant */
  variant?: 'default' | 'muted' | 'accent';
  /** Custom className */
  className?: string;
}

export function Features({
  title,
  subtitle,
  features,
  columns = 3,
  variant = 'muted',
  className,
}: FeaturesProps) {
  return (
    <Section id="features" spacing="xl" variant={variant} container className={className}>
      {/* Section Header */}
      {(title || subtitle) && (
        <div className="text-left w-full mb-16">
          {subtitle && (
            <p className="text-brand-primary font-semibold mb-3 uppercase tracking-wide text-sm subheading-neon">
              {subtitle}
            </p>
          )}
          {title && (
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold mb-4 header-animated">
              {title}
            </h2>
          )}
        </div>
      )}

      {/* Features Grid */}
      <Grid cols={columns} gap="lg">
        {features.map((feature, index) => (
          <div
            key={index}
            className="animate-slide-up"
            style={{ animationDelay: `${index * 100}ms` }}
          >
            <FeatureCard feature={feature} />
          </div>
        ))}
      </Grid>
    </Section>
  );
}

/**
 * Feature Card Component
 */
interface FeatureCardProps {
  feature: Feature;
}

function FeatureCard({ feature }: FeatureCardProps) {
  const Component = feature.href ? 'a' : 'div';
  const { ref, position } = useMouseFollow(0.15);

  return (
    <Component
      ref={ref as any}
      href={feature.href}
      className={cn(
        'group relative p-8 rounded-2xl overflow-hidden',
        'bg-white dark:bg-gray-900',
        'border border-gray-200 dark:border-gray-800',
        'transition-all duration-500 ease-out',
        'hover:shadow-2xl hover:shadow-brand-accent/20',
        'hover:border-brand-accent/50',
        'card-3d',
        feature.href && 'cursor-pointer'
      )}
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
      }}
    >
      {/* Gradient overlay on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand-primary/0 via-brand-accent/0 to-brand-secondary/0 group-hover:from-brand-primary/5 group-hover:via-brand-accent/5 group-hover:to-brand-secondary/5 transition-all duration-500" />

      {/* Glow effect */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-brand-accent to-transparent" />
      </div>

      <div className="relative z-10">
        {/* Icon */}
        {feature.icon && (
          <div className="mb-6 text-5xl flex items-center justify-start transform transition-all duration-500 group-hover:scale-110 group-hover:rotate-3">
            {typeof feature.icon === 'string' ? (
              <span role="img" aria-hidden="true" className="filter drop-shadow-lg">
                {feature.icon}
              </span>
            ) : (
              feature.icon
            )}
          </div>
        )}

        {/* Title */}
        <h3 className="text-xl font-bold mb-3 group-hover:text-brand-accent transition-colors duration-300">
          {feature.title}
        </h3>

        {/* Description */}
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed group-hover:text-gray-700 dark:group-hover:text-gray-300 transition-colors duration-300">
          {feature.description}
        </p>

        {/* Hover Arrow */}
        {feature.href && (
          <div className="mt-6 flex items-center text-brand-accent opacity-0 group-hover:opacity-100 transform translate-x-0 group-hover:translate-x-2 transition-all duration-300">
            <span className="text-sm font-semibold">Learn more</span>
            <svg
              className="w-4 h-4 ml-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
          </div>
        )}
      </div>
    </Component>
  );
}
