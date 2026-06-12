'use client';

import * as React from 'react';
import { Section, Container, Grid } from '@/components/layout';
import { cn } from '@/lib/utils';
import { useTextReveal } from '@/hooks/useTextReveal';

/**
 * Solution Overview Section
 *
 * High-level explanation of how Tanglement.ai solves the problem
 * without revealing implementation details
 */

interface Benefit {
  icon: string;
  title: string;
  description: string;
}

export interface SolutionOverviewProps {
  /** Section title */
  title?: string;
  /** Section subtitle */
  subtitle?: string;
  /** Benefits to display */
  benefits?: Benefit[];
  /** Custom className */
  className?: string;
}

const defaultBenefits: Benefit[] = [
  {
    icon: '🧠',
    title: 'Client-Side Intelligence',
    description:
      'Routing decisions happen on your device, not our servers. You maintain full control and privacy.',
  },
  {
    icon: '🔀',
    title: 'Multi-Provider by Default',
    description:
      'Automatic failover across OpenAI, Anthropic, Google, and more. No vendor lock-in, ever.',
  },
  {
    icon: '🔐',
    title: 'Privacy-First Architecture',
    description:
      'Your API keys never leave your infrastructure. End-to-end encryption ensures complete security.',
  },
  {
    icon: '🌐',
    title: 'Decentralized Network',
    description:
      'No central servers to fail or bottleneck. Built on peer-to-peer architecture for maximum reliability.',
  },
];

export function SolutionOverview({
  title = 'A Network Built Differently',
  subtitle = 'The Solution',
  benefits = defaultBenefits,
  className,
}: SolutionOverviewProps) {
  const descriptionRef = useTextReveal();

  return (
    <Section
      id="solution"
      spacing="xl"
      variant="default"
      className={className}
    >
      <Container>
        {/* Header */}
        <div className="w-full text-left mb-16">
          {subtitle && (
            <div className="inline-block px-4 py-2 rounded-full bg-success/10 text-success font-semibold text-sm mb-4 subheading-neon">
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
            Tanglement.ai is the decentralized routing layer for LLM access.
            Our client-side SDK intelligently routes requests to the optimal provider
            based on cost, performance, and reliability.
          </p>
        </div>

        {/* Architecture Comparison */}
        <div className="mb-20">
          <h3 className="text-2xl font-bold text-left mb-12">
            Centralized vs. Decentralized Architecture
          </h3>
          <Grid cols={2} gap="xl" className="max-w-5xl mx-auto">
            {/* Centralized (Traditional) */}
            <div className="p-8 rounded-2xl bg-red-50 dark:bg-red-950/20 border-2 border-red-200 dark:border-red-800">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-red-500 flex items-center justify-center text-white text-xl">
                  ⚠️
                </div>
                <div>
                  <h4 className="text-xl font-bold">Traditional (Centralized)</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Single Point of Failure</p>
                </div>
              </div>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <span className="text-red-500 mt-1">✗</span>
                  <span className="text-gray-700 dark:text-gray-300">Vendor lock-in to single provider</span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-red-500 mt-1">✗</span>
                  <span className="text-gray-700 dark:text-gray-300">Central servers create bottlenecks</span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-red-500 mt-1">✗</span>
                  <span className="text-gray-700 dark:text-gray-300">No failover when provider fails</span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-red-500 mt-1">✗</span>
                  <span className="text-gray-700 dark:text-gray-300">Premium pricing with no alternatives</span>
                </div>
              </div>
            </div>

            {/* Decentralized (Tanglement.ai) */}
            <div className="p-8 rounded-2xl bg-gradient-to-br from-brand-primary/10 to-brand-accent/10 border-2 border-brand-accent dark:border-brand-accent/50 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-brand-accent/20 rounded-full blur-3xl" />
              <div className="relative">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-12 h-12 rounded-full bg-brand-accent flex items-center justify-center text-white text-xl">
                    ✓
                  </div>
                  <div>
                    <h4 className="text-xl font-bold">Tanglement.ai (Decentralized)</h4>
                    <p className="text-sm text-gray-600 dark:text-gray-400">Resilient P2P Network</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <span className="text-brand-accent mt-1">✓</span>
                    <span className="text-gray-700 dark:text-gray-300">Multi-provider routing & failover</span>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="text-brand-accent mt-1">✓</span>
                    <span className="text-gray-700 dark:text-gray-300">Decentralized - no central servers</span>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="text-brand-accent mt-1">✓</span>
                    <span className="text-gray-700 dark:text-gray-300">99.9% uptime through redundancy</span>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="text-brand-accent mt-1">✓</span>
                    <span className="text-gray-700 dark:text-gray-300">20-40% cost savings through optimization</span>
                  </div>
                </div>
              </div>
            </div>
          </Grid>
        </div>

        {/* Key Benefits Grid */}
        <div className="max-w-6xl mx-auto">
          <h3 className="text-2xl font-bold text-left mb-12">How It Works</h3>
          <Grid cols={4} gap="lg">
            {benefits.map((benefit, index) => (
              <BenefitCard key={index} {...benefit} index={index} />
            ))}
          </Grid>
        </div>

        {/* Simple Flow Diagram */}
        <div className="mt-20 p-12 rounded-2xl bg-gradient-to-br from-gray-50 to-white dark:from-gray-900 dark:to-gray-800 border border-gray-200 dark:border-gray-700">
          <h3 className="text-xl font-bold text-left mb-8">Request Flow</h3>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <RequestFlowStep number={1} label="Your App" icon="💻" />
            <Arrow />
            <RequestFlowStep number={2} label="Tanglement SDK" icon="🎯" />
            <Arrow />
            <RequestFlowStep number={3} label="Optimal Provider" icon="🚀" />
            <Arrow />
            <RequestFlowStep number={4} label="Response" icon="✨" />
          </div>
          <p className="text-center text-gray-600 dark:text-gray-400 mt-8 text-sm">
            All routing happens client-side. No data flows through our servers.
          </p>
        </div>
      </Container>
    </Section>
  );
}

/**
 * Benefit Card Component
 */
function BenefitCard({
  icon,
  title,
  description,
  index,
}: Benefit & { index: number }) {
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
        'group p-6 rounded-xl card-surface',
        'hover:border-brand-accent hover:shadow-lg transition-all duration-300',
        'transform',
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
      )}
    >
      <div className="text-4xl mb-4">{icon}</div>
      <h4 className="text-lg font-bold mb-2 group-hover:text-brand-accent transition-colors">
        {title}
      </h4>
      <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
        {description}
      </p>
    </div>
  );
}

/**
 * Request Flow Step Component
 */
function RequestFlowStep({
  number,
  label,
  icon,
}: {
  number: number;
  label: string;
  icon: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-brand-primary to-brand-accent flex items-center justify-center text-3xl">
          {icon}
        </div>
        <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-brand-accent text-white flex items-center justify-center text-sm font-bold">
          {number}
        </div>
      </div>
      <span className="text-sm font-semibold">{label}</span>
    </div>
  );
}

/**
 * Arrow Component
 */
function Arrow() {
  return (
    <div className="text-brand-accent text-2xl hidden md:block">→</div>
  );
}
