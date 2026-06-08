'use client';

import * as React from 'react';
import { Section, Container, Grid, Stack } from '@/components/layout';
import { cn } from '@/lib/utils';
import { Shield, Lock, Code, Users, Award, CheckCircle } from 'lucide-react';
import { useScrollAnimation } from '@/hooks/useScrollAnimation';

/**
 * TrustIndicators Component
 *
 * Build trust through security commitments, team transparency, and roadmap
 */

export interface TrustIndicatorsProps {
  title?: string;
  subtitle?: string;
  className?: string;
}

const securityCommitments = [
  {
    icon: <Lock className="h-6 w-6" />,
    title: 'Client-Side Key Storage',
    description: 'Your API keys never touch our servers. All routing decisions happen on your device.',
  },
  {
    icon: <Shield className="h-6 w-6" />,
    title: 'Zero Trust Architecture',
    description: 'End-to-end encryption. We cannot see your prompts, responses, or API credentials.',
  },
  {
    icon: <Code className="h-6 w-6" />,
    title: 'Open Source Core',
    description: 'SDK and routing logic are open source. Audit our code, verify our promises.',
  },
  {
    icon: <Award className="h-6 w-6" />,
    title: 'SOC 2 Type II Compliant',
    description: 'Enterprise-grade security controls verified by independent auditors.',
  },
];

const roadmapPhases = [
  {
    phase: 'Private Alpha',
    status: 'completed',
    description: 'Limited testing with select partners',
    date: 'Q4 2024',
  },
  {
    phase: 'Private Beta',
    status: 'active',
    description: 'Waitlist users join gradually',
    date: 'Q1 2026',
  },
  {
    phase: 'Public Beta',
    status: 'upcoming',
    description: 'Open to all developers',
    date: 'Q2 2026',
  },
  {
    phase: 'General Availability',
    status: 'planned',
    description: 'Production-ready launch',
    date: 'Q3 2026',
  },
];

const teamHighlights = [
  {
    role: 'Engineering Leadership',
    description: 'Former infrastructure leads from Stripe, Cloudflare, and AWS',
  },
  {
    role: 'AI/ML Expertise',
    description: 'Research backgrounds from OpenAI, Google Brain, and Anthropic',
  },
  {
    role: 'Distributed Systems',
    description: 'Built P2P networks serving 100M+ users at scale',
  },
];

function SecurityCard({ item }: { item: typeof securityCommitments[0] }) {
  return (
    <div className="group p-6 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 hover:border-brand-accent/50 transition-all duration-500 card-3d hover:shadow-xl hover:shadow-brand-accent/10">
      {/* Gradient overlay on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand-primary/0 via-brand-accent/0 to-brand-secondary/0 group-hover:from-brand-primary/5 group-hover:via-brand-accent/5 group-hover:to-brand-secondary/5 transition-all duration-500 rounded-xl" />

      <div className="relative z-10 flex items-start gap-4">
        <div className="flex-shrink-0 p-3 rounded-lg bg-brand-accent/10 text-brand-accent transform group-hover:scale-110 group-hover:rotate-3 transition-all duration-300">
          {item.icon}
        </div>
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2 group-hover:text-brand-accent transition-colors duration-300">{item.title}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">{item.description}</p>
        </div>
      </div>
    </div>
  );
}

function RoadmapTimeline() {
  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-[15px] top-0 bottom-0 w-0.5 bg-gradient-to-b from-brand-accent via-brand-secondary to-gray-300" />

      <div className="space-y-6">
        {roadmapPhases.map((phase, index) => (
          <div key={index} className="relative flex gap-6">
            {/* Status dot */}
            <div className="relative z-10 flex-shrink-0">
              <div
                className={cn(
                  'h-8 w-8 rounded-full border-4 flex items-center justify-center',
                  phase.status === 'completed'
                    ? 'bg-green-500 border-green-200'
                    : phase.status === 'active'
                      ? 'bg-brand-accent border-brand-accent/20 animate-pulse'
                      : 'bg-gray-300 border-gray-100'
                )}
              >
                {phase.status === 'completed' && <CheckCircle className="h-4 w-4 text-white" />}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 pb-6">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-semibold text-gray-900 dark:text-white">{phase.phase}</h3>
                <span
                  className={cn(
                    'text-xs font-medium px-2 py-1 rounded-full',
                    phase.status === 'completed'
                      ? 'bg-green-100 text-green-700'
                      : phase.status === 'active'
                        ? 'bg-brand-accent/10 text-brand-accent'
                        : 'bg-gray-100 text-gray-600'
                  )}
                >
                  {phase.status}
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">{phase.description}</p>
              <p className="text-xs text-gray-500">{phase.date}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamSection() {
  return (
    <div className="group p-8 rounded-xl bg-gradient-to-br from-brand-primary/5 to-brand-secondary/5 border border-brand-accent/20 hover:border-brand-accent/40 transition-all duration-500 hover:shadow-lg hover:shadow-brand-accent/10">
      <div className="flex items-center gap-3 mb-6">
        <Users className="h-6 w-6 text-brand-accent" />
        <h3 className="text-xl font-semibold text-gray-900 dark:text-white">World-Class Team</h3>
      </div>

      <Stack spacing="md">
        {teamHighlights.map((highlight, index) => (
          <div
            key={index}
            className="flex gap-3 animate-slide-up"
            style={{ animationDelay: `${index * 100}ms` }}
          >
            <div className="flex-shrink-0 mt-1">
              <div className="h-2 w-2 rounded-full bg-brand-accent animate-pulse" />
            </div>
            <div>
              <div className="font-medium text-gray-900 dark:text-white">{highlight.role}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400">{highlight.description}</div>
            </div>
          </div>
        ))}
      </Stack>

      <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          We're backed by top-tier investors including Sequoia, a16z, and Y Combinator. Learn more about our{' '}
          <a href="/about" className="text-brand-accent hover:underline font-medium">
            team and mission →
          </a>
        </p>
      </div>
    </div>
  );
}

export function TrustIndicators({
  title = 'Built on Trust, Transparency, and Security',
  subtitle = 'Why Developers Trust Us',
  className,
}: TrustIndicatorsProps) {
  const { ref: headerRef, isVisible: headerVisible } = useScrollAnimation({ threshold: 0.2 });
  const { ref: securityRef, isVisible: securityVisible } = useScrollAnimation({ threshold: 0.2, delay: 100 });
  const { ref: roadmapRef, isVisible: roadmapVisible } = useScrollAnimation({ threshold: 0.2, delay: 200 });

  return (
    <Section spacing="xl" variant="default" className={cn('relative overflow-hidden', className)}>
      {/* Gradient mesh background */}
      <div className="absolute inset-0 gradient-mesh opacity-10 pointer-events-none" />

      <Container className="relative z-10">
        {/* Header */}
        <div
          ref={headerRef}
          className={cn(
            'mb-16 text-center transition-all duration-700',
            headerVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-brand-accent">
            {subtitle}
          </p>
          <h2 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">{title}</h2>
          <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
            Your infrastructure, your keys, your control. We're building the trust layer for the AI economy.
          </p>
        </div>

        {/* Security Commitments */}
        <Grid
          cols={2}
          gap="md"
          className={cn(
            'mb-16 transition-all duration-700',
            securityVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          <div ref={securityRef} className="col-span-2 grid grid-cols-2 gap-4">
            {securityCommitments.map((item, index) => (
              <div
                key={index}
                className="col-span-1 animate-slide-up"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <SecurityCard item={item} />
              </div>
            ))}
          </div>
        </Grid>

        {/* Roadmap & Team */}
        <Grid
          cols={2}
          gap="lg"
          className={cn(
            'transition-all duration-700',
            roadmapVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          {/* Roadmap */}
          <div ref={roadmapRef} className="col-span-1">
            <div className="mb-6">
              <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Product Roadmap</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Transparent timeline from alpha to general availability
              </p>
            </div>
            <RoadmapTimeline />
          </div>

          {/* Team */}
          <div className="col-span-1">
            <TeamSection />

            {/* Open Source Commitment */}
            <div className="mt-6 p-6 rounded-xl bg-gray-900 dark:bg-gray-800 text-white hover:shadow-xl hover:shadow-brand-accent/10 transition-all duration-500">
              <div className="flex items-center gap-3 mb-4">
                <Code className="h-6 w-6 text-brand-accent" />
                <h3 className="text-lg font-semibold">Open Source Commitment</h3>
              </div>
              <p className="text-sm text-gray-300 mb-4">
                Our SDK and routing algorithms are open source. We believe transparency builds trust, and trust builds better infrastructure.
              </p>
              <a
                href="https://github.com/tanglement-ai"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-medium text-brand-accent hover:underline"
              >
                View on GitHub →
              </a>
            </div>
          </div>
        </Grid>
      </Container>
    </Section>
  );
}
