'use client';

import * as React from 'react';
import { Section, Container, Grid } from '@/components/layout';
import { cn } from '@/lib/utils';
import { useTextReveal } from '@/hooks/useTextReveal';

/**
 * Problem Statement Section
 *
 * Articulates current LLM access pain points with data visualization
 */

interface PainPoint {
  icon: string;
  title: string;
  metric: string;
  description: string;
}

export interface ProblemStatementProps {
  /** Section title */
  title?: string;
  /** Section subtitle */
  subtitle?: string;
  /** Pain points to display */
  painPoints?: PainPoint[];
  /** Custom className */
  className?: string;
}

const defaultPainPoints: PainPoint[] = [
  {
    icon: '💸',
    title: 'Sky-High Costs',
    metric: '$0.002-0.03 per token',
    description:
      'Paying premium rates with no optimization path. Small teams spend $5K-50K/month with zero cost control.',
  },
  {
    icon: '🔒',
    title: 'Vendor Lock-In',
    metric: '87% single-provider',
    description:
      'Locked into OpenAI or Anthropic with no failover. Switching providers means rewriting integration code.',
  },
  {
    icon: '🚨',
    title: 'Unreliable Service',
    metric: '43 outages in 2024',
    description:
      'Production outages cost customers and revenue. When OpenAI goes down, your entire application fails.',
  },
  {
    icon: '📊',
    title: 'Zero Transparency',
    metric: '12 price changes/year',
    description:
      'Hidden pricing changes, opaque billing, surprise costs. No visibility into what you\'re actually paying for.',
  },
];

export function ProblemStatement({
  title = 'LLM Access is Broken',
  subtitle = 'The Problem',
  painPoints = defaultPainPoints,
  className,
}: ProblemStatementProps) {
  const descriptionRef = useTextReveal();

  return (
    <Section
      id="problem"
      spacing="xl"
      variant="muted"
      className={className}
    >
      <Container>
        {/* Header */}
        <div className="w-full text-left mb-16">
          {subtitle && (
            <div className="inline-block px-4 py-2 rounded-full bg-error/10 text-error font-semibold text-sm mb-4 subheading-neon">
              {subtitle}
            </div>
          )}
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6 header-animated">
            {title}
          </h2>
          <p
            ref={descriptionRef as React.RefObject<HTMLParagraphElement>}
            className="text-xl text-gray-600 dark:text-gray-300 text-justify"
          >
            Current LLM infrastructure is expensive, unreliable, and inflexible.
            Organizations are trapped in vendor ecosystems with no escape path.
          </p>
        </div>

        {/* Pain Points Grid */}
        <Grid cols={2} gap="lg" className="max-w-6xl mx-auto">
          {painPoints.map((point, index) => (
            <PainPointCard key={index} {...point} index={index} />
          ))}
        </Grid>

        {/* Market Context */}
        <div className="mt-16 p-8 rounded-2xl bg-gradient-to-br from-gray-900 to-gray-800 text-white">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="text-4xl md:text-5xl font-bold mb-2">$2.8B+</div>
              <div className="text-gray-300">Addressable Market</div>
            </div>
            <div>
              <div className="text-4xl md:text-5xl font-bold mb-2">2.4M+</div>
              <div className="text-gray-300">Developers Using LLMs</div>
            </div>
            <div>
              <div className="text-4xl md:text-5xl font-bold mb-2">68%</div>
              <div className="text-gray-300">Report Cost Concerns</div>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}

/**
 * Pain Point Card Component
 */
function PainPointCard({
  icon,
  title,
  metric,
  description,
  index,
}: PainPoint & { index: number }) {
  const [isVisible, setIsVisible] = React.useState(false);
  const cardRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setIsVisible(true), index * 100);
        }
      },
      { threshold: 0.1 }
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);
    }

    return () => observer.disconnect();
  }, [index]);

  return (
    <div
      ref={cardRef}
      className={cn(
        'group relative p-8 rounded-2xl bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700',
        'hover:border-error hover:shadow-xl transition-all duration-300',
        'transform',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
      )}
      style={{ transitionDelay: `${index * 50}ms` }}
    >
      {/* Icon */}
      <div className="text-5xl mb-4">{icon}</div>

      {/* Title */}
      <h3 className="text-2xl font-bold mb-2 group-hover:text-error transition-colors">
        {title}
      </h3>

      {/* Metric */}
      <div className="text-3xl font-bold text-error mb-4">{metric}</div>

      {/* Description */}
      <p className="text-gray-600 dark:text-gray-300 leading-relaxed">
        {description}
      </p>

      {/* Accent Line */}
      <div className="absolute bottom-0 left-8 right-8 h-1 bg-gradient-to-r from-error/0 via-error to-error/0 transform scale-x-0 group-hover:scale-x-100 transition-transform duration-500" />
    </div>
  );
}
