'use client';

import * as React from 'react';
import { Section, Container, Stack } from '@/components/layout';
import { Button, ScrollIndicator } from '@/components/ui';
import { WaitlistForm } from '@/components/WaitlistForm';
import { cn } from '@/lib/utils';
import { useParallax } from '@/hooks/useScrollAnimation';
import { useTextReveal } from '@/hooks/useTextReveal';

/**
 * Hero Section Component
 *
 * Full-screen hero with animated headline, subtitle, and CTA
 */

export interface HeroProps {
  /** Hero variant */
  variant?: 'default' | 'gradient' | 'dark';
  /** Main headline */
  headline: string;
  /** Animated headline parts (cycles through) */
  animatedHeadline?: string[];
  /** Subtitle/tagline */
  subtitle?: string;
  /** Description text */
  description?: string;
  /** Show waitlist form */
  showWaitlist?: boolean;
  /** Waitlist source identifier */
  waitlistSource?: string;
  /** Custom CTA buttons */
  cta?: React.ReactNode;
  /** Background image URL */
  backgroundImage?: string;
  /** Show scroll indicator */
  showScrollIndicator?: boolean;
  /** Custom className */
  className?: string;
}

export function Hero({
  variant = 'gradient',
  headline,
  animatedHeadline,
  subtitle,
  description,
  showWaitlist = true,
  waitlistSource = 'hero',
  cta,
  backgroundImage,
  showScrollIndicator = true,
  className,
}: HeroProps) {
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [isAnimating, setIsAnimating] = React.useState(false);
  const { ref: parallaxRef, offset: parallaxOffset } = useParallax(0.3);
  const descriptionRef = useTextReveal();

  // Rotate through animated headline parts
  React.useEffect(() => {
    if (!animatedHeadline || animatedHeadline.length === 0) return;

    const interval = setInterval(() => {
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % animatedHeadline.length);
        setIsAnimating(false);
      }, 300);
    }, 3000);

    return () => clearInterval(interval);
  }, [animatedHeadline]);

  const currentAnimatedText = animatedHeadline?.[currentIndex];

  return (
    <Section
      as="section"
      spacing="none"
      variant={variant}
      id="hero"
      className={cn('relative min-h-screen flex items-center', className)}
    >
      {/* Background Image */}
      {backgroundImage && (
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-20"
          style={{ backgroundImage: `url(${backgroundImage})` }}
          aria-hidden="true"
        />
      )}

      {/* Variant-specific overlays - REMOVED to show FluidBackground */}
      {/* FluidBackground from layout.tsx provides the background for entire site */}

      {/* Floating particles */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-brand-accent rounded-full animate-float opacity-60" />
        <div className="absolute top-1/3 right-1/4 w-1.5 h-1.5 bg-brand-secondary rounded-full animate-float animation-delay-300 opacity-40" />
        <div className="absolute bottom-1/3 left-1/3 w-1 h-1 bg-brand-accent rounded-full animate-float animation-delay-600 opacity-50" />
        <div className="absolute top-2/3 right-1/3 w-2 h-2 bg-brand-primary rounded-full animate-float animation-delay-200 opacity-30" />
        <div className="absolute bottom-1/4 left-2/3 w-1.5 h-1.5 bg-brand-accent rounded-full animate-float animation-delay-500 opacity-45" />
      </div>

      {/* Content */}
      <Container className="relative z-10">
        <div className="w-full text-left">
          <Stack spacing="xl" align="start">
            {/* Subtitle Badge */}
            {subtitle && (
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-sm font-medium animate-slide-up subheading-neon">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-accent opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-accent" />
                </span>
                {subtitle}
              </div>
            )}

            {/* Headline */}
            <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-extrabold tracking-[-0.02em] leading-[0.95] uppercase animate-slide-up animation-delay-100">
              <span className="block header-animated">
                {headline}
              </span>
              {currentAnimatedText && (
                <>
                  <span
                    className={cn(
                      'block mt-2 header-animated transition-opacity duration-300',
                      isAnimating ? 'opacity-0' : 'opacity-100'
                    )}
                  >
                    {currentAnimatedText}
                  </span>
                </>
              )}
            </h1>

            {/* Description */}
            {description && (
              <p
                ref={descriptionRef as React.RefObject<HTMLParagraphElement>}
                className="text-lg sm:text-xl md:text-2xl text-gray-600 dark:text-gray-300 w-full text-justify animate-slide-up animation-delay-200"
              >
                {description}
              </p>
            )}

            {/* CTA Section */}
            <div className="w-full max-w-xl mx-auto mt-8 animate-slide-up animation-delay-300">
              {showWaitlist ? (
                <WaitlistForm source={waitlistSource} fullWidth />
              ) : cta ? (
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                  {cta}
                </div>
              ) : null}
            </div>
          </Stack>
        </div>
      </Container>

      {/* Scroll Indicator */}
      {showScrollIndicator && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2">
          <ScrollIndicator targetId="features" />
        </div>
      )}
    </Section>
  );
}
