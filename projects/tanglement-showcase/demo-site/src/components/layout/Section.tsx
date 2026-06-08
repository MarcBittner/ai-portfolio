import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Section Component
 *
 * Semantic section wrapper with consistent vertical spacing
 */

const sectionVariants = cva(['w-full'], {
  variants: {
    spacing: {
      none: 'py-0',
      sm: 'py-8 md:py-12',
      md: 'py-12 md:py-16',
      lg: 'py-16 md:py-24',
      xl: 'py-24 md:py-32',
      '2xl': 'py-32 md:py-40',
    },
    variant: {
      default: 'bg-transparent',
      muted: 'bg-transparent',
      accent: 'bg-brand-primary/5 dark:bg-brand-primary/10',
      dark: 'bg-gray-900/90 dark:bg-gray-950/90 text-white',
      gradient: [
        'bg-gradient-to-br',
        'from-brand-primary/10',
        'via-brand-secondary/5',
        'to-brand-accent/10',
      ],
    },
  },
  defaultVariants: {
    spacing: 'lg',
    variant: 'default',
  },
});

export interface SectionProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof sectionVariants> {
  /** Render as a different HTML element */
  as?: 'section' | 'div' | 'article' | 'aside' | 'header' | 'footer' | 'main';
  /** Add a container wrapper */
  container?: boolean;
  /** Container size (only applies if container=true) */
  containerSize?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
}

/**
 * Section component for semantic page sections with consistent spacing
 *
 * @example
 * ```tsx
 * <Section spacing="xl" variant="muted" container>
 *   <h2>Section Title</h2>
 *   <p>Section content</p>
 * </Section>
 *
 * <Section spacing="lg" variant="gradient" as="article">
 *   <Article />
 * </Section>
 * ```
 */
export const Section = React.forwardRef<HTMLElement, SectionProps>(
  (
    {
      className,
      spacing,
      variant,
      as: Component = 'section',
      container = false,
      containerSize = 'xl',
      children,
      ...props
    },
    ref
  ) => {
    const content = container ? (
      <div className={cn('mx-auto w-full px-6', `max-w-screen-${containerSize}`)}>
        {children}
      </div>
    ) : (
      children
    );

    return (
      <Component
        ref={ref as any}
        className={cn(sectionVariants({ spacing, variant }), className)}
        {...props}
      >
        {content}
      </Component>
    );
  }
);

Section.displayName = 'Section';
