'use client';

import * as React from 'react';
import { Section, Container, Grid } from '@/components/layout';
import { cn } from '@/lib/utils';
import { Activity, Globe, TrendingDown, Zap } from 'lucide-react';
import { useScrollAnimation } from '@/hooks/useScrollAnimation';

/**
 * NetworkStatus Component
 *
 * Real-time network metrics dashboard showing Tanglement.ai performance
 */

export interface NetworkStatusProps {
  title?: string;
  subtitle?: string;
  className?: string;
}

interface Metric {
  label: string;
  value: string;
  change: string;
  icon: React.ReactNode;
  color: string;
}

// Simulated real-time data
function useNetworkMetrics() {
  const [metrics, setMetrics] = React.useState<Metric[]>([
    {
      label: 'Requests Routed',
      value: '2,847,392',
      change: '+12.3% vs yesterday',
      icon: <Activity className="h-6 w-6" />,
      color: 'text-brand-accent',
    },
    {
      label: 'Active Nodes',
      value: '1,249',
      change: '+47 in last hour',
      icon: <Globe className="h-6 w-6" />,
      color: 'text-green-400',
    },
    {
      label: 'Avg Cost Savings',
      value: '38.2%',
      change: 'Across all tiers',
      icon: <TrendingDown className="h-6 w-6" />,
      color: 'text-blue-400',
    },
    {
      label: 'Network Uptime',
      value: '99.94%',
      change: 'Last 30 days',
      icon: <Zap className="h-6 w-6" />,
      color: 'text-yellow-400',
    },
  ]);

  // Simulate live updates
  React.useEffect(() => {
    const interval = setInterval(() => {
      setMetrics((prev) =>
        prev.map((metric, index) => {
          if (index === 0) {
            // Requests routed - increment randomly
            const current = parseInt(metric.value.replace(/,/g, ''));
            const newValue = (current + Math.floor(Math.random() * 100)).toLocaleString();
            return { ...metric, value: newValue };
          }
          return metric;
        })
      );
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  return metrics;
}

function MetricCard({ metric }: { metric: Metric }) {
  return (
    <div className="group p-6 rounded-xl glass-dark border border-gray-800 hover:border-brand-accent/50 transition-all duration-500 card-3d hover:shadow-2xl hover:shadow-brand-accent/10">
      {/* Gradient overlay on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand-primary/0 via-brand-accent/0 to-brand-secondary/0 group-hover:from-brand-primary/5 group-hover:via-brand-accent/5 group-hover:to-brand-secondary/5 transition-all duration-500 rounded-xl" />

      <div className="relative z-10">
        {/* Icon */}
        <div className={cn('mb-4 transform group-hover:scale-110 transition-transform duration-300', metric.color)}>{metric.icon}</div>

        {/* Value */}
        <div className="text-3xl font-bold text-white mb-1 group-hover:text-brand-accent transition-colors duration-300">{metric.value}</div>

        {/* Label */}
        <div className="text-sm font-medium text-gray-300 mb-2">{metric.label}</div>

        {/* Change */}
        <div className="text-xs text-gray-500">{metric.change}</div>
      </div>
    </div>
  );
}

function ProviderStatus() {
  const providers = [
    { name: 'OpenAI', status: 'operational', latency: '124ms', uptime: '99.9%' },
    { name: 'Anthropic', status: 'operational', latency: '98ms', uptime: '99.8%' },
    { name: 'Google', status: 'operational', latency: '156ms', uptime: '99.7%' },
    { name: 'Cohere', status: 'degraded', latency: '342ms', uptime: '98.2%' },
  ];

  return (
    <div className="p-6 rounded-xl glass-dark border border-gray-800 hover:border-brand-accent/30 transition-all duration-500">
      <h3 className="text-lg font-semibold text-white mb-4">Provider Status</h3>

      <div className="space-y-3">
        {providers.map((provider, index) => (
          <div
            key={provider.name}
            className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50 hover:bg-gray-800 transition-all duration-300 animate-slide-up"
            style={{ animationDelay: `${index * 75}ms` }}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'h-2 w-2 rounded-full',
                  provider.status === 'operational' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400 animate-pulse'
                )}
              />
              <span className="text-sm font-medium text-white">{provider.name}</span>
            </div>

            <div className="flex gap-4 text-xs text-gray-400">
              <span>{provider.latency}</span>
              <span>{provider.uptime}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GeographicDistribution() {
  const regions = [
    { name: 'North America', percentage: 42 },
    { name: 'Europe', percentage: 28 },
    { name: 'Asia Pacific', percentage: 20 },
    { name: 'South America', percentage: 6 },
    { name: 'Africa', percentage: 4 },
  ];

  return (
    <div className="p-6 rounded-xl glass-dark border border-gray-800 hover:border-brand-accent/30 transition-all duration-500">
      <h3 className="text-lg font-semibold text-white mb-4">Geographic Distribution</h3>

      <div className="space-y-3">
        {regions.map((region, index) => (
          <div
            key={region.name}
            className="animate-slide-up"
            style={{ animationDelay: `${index * 75}ms` }}
          >
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-300">{region.name}</span>
              <span className="text-brand-accent font-medium">{region.percentage}%</span>
            </div>
            <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-brand-accent to-brand-secondary transition-all duration-1000"
                style={{ width: `${region.percentage}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NetworkStatus({
  title = 'Network Performance',
  subtitle = 'Live Metrics',
  className,
}: NetworkStatusProps) {
  const metrics = useNetworkMetrics();
  const { ref: headerRef, isVisible: headerVisible } = useScrollAnimation({ threshold: 0.2 });
  const { ref: metricsRef, isVisible: metricsVisible } = useScrollAnimation({ threshold: 0.2, delay: 100 });
  const { ref: statusRef, isVisible: statusVisible } = useScrollAnimation({ threshold: 0.2, delay: 200 });

  return (
    <Section spacing="xl" variant="muted" className={cn('relative overflow-hidden', className)}>
      {/* Background Pattern */}
      <div className="absolute inset-0 opacity-5">
        <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '24px 24px' }} />
      </div>
      {/* Gradient mesh overlay */}
      <div className="absolute inset-0 gradient-mesh opacity-20 pointer-events-none" />

      <Container className="relative z-10">
        {/* Header */}
        <div
          ref={headerRef}
          className={cn(
            'mb-12 text-center transition-all duration-700',
            headerVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-brand-accent">
            {subtitle}
          </p>
          <h2 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">{title}</h2>
          <p className="text-lg text-gray-600 dark:text-gray-400">
            Real-time insights into the decentralized Tanglement.ai network
          </p>
        </div>

        {/* Metrics Grid */}
        <Grid
          cols={4}
          gap="md"
          className={cn(
            'mb-8 transition-all duration-700',
            metricsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          <div ref={metricsRef} className="col-span-4 grid grid-cols-4 gap-4">
            {metrics.map((metric, index) => (
              <div
                key={index}
                className="col-span-1 animate-slide-up"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <MetricCard metric={metric} />
              </div>
            ))}
          </div>
        </Grid>

        {/* Provider & Geographic Status */}
        <Grid
          cols={2}
          gap="md"
          className={cn(
            'transition-all duration-700',
            statusVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          <div ref={statusRef} className="col-span-1">
            <ProviderStatus />
          </div>
          <div className="col-span-1">
            <GeographicDistribution />
          </div>
        </Grid>

        {/* Disclaimer */}
        <div className="mt-8 text-center">
          <p className="text-sm text-gray-500">
            <span className="font-semibold">Note:</span> Network metrics are simulated for preview purposes.
            Actual performance data will be available during beta.
          </p>
        </div>

        {/* Live Indicator */}
        <div className="mt-6 flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/30">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
            </span>
            <span className="text-sm font-medium text-green-600 dark:text-green-400">
              Live Network Data
            </span>
          </div>
        </div>
      </Container>
    </Section>
  );
}
