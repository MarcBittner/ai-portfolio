import {
  Hero,
  ProblemStatement,
  SolutionOverview,
  Features,
  CodeSamples,
  NetworkStatus,
  Testimonials,
  TrustIndicators,
  FAQ,
  Footer,
  type Feature,
} from '@/components/sections';

export default function Home() {
  const features: Feature[] = [
    {
      icon: '💰',
      title: '40% Cost Savings',
      description:
        'Reduce your LLM access costs by 20-40% through intelligent multi-provider routing and decentralized architecture.',
    },
    {
      icon: '🔓',
      title: 'Zero Vendor Lock-In',
      description:
        'Automatic failover across OpenAI, Anthropic, Google, and more. Switch providers seamlessly without changing code.',
    },
    {
      icon: '🔒',
      title: 'Privacy-First',
      description:
        'Your API keys never leave your device. Client-side routing ensures your credentials stay in your infrastructure.',
    },
    {
      icon: '🌐',
      title: 'Decentralized Network',
      description:
        'No central servers to fail or bottleneck. Built on a peer-to-peer architecture for maximum reliability.',
    },
    {
      icon: '⚡',
      title: '99.9% Uptime SLA',
      description:
        'Enterprise-grade reliability with multi-provider redundancy. When one provider fails, traffic routes automatically.',
    },
    {
      icon: '🛡️',
      title: 'Client-Side Intelligence',
      description:
        'Routing decisions happen on your device, not our servers. You maintain full control over your LLM access.',
    },
  ];

  return (
    <>
      <Hero
        variant="gradient"
        subtitle="Launching Soon"
        headline="The Decentralized Routing Layer for"
        animatedHeadline={[
          'LLM Access',
          'AI-Powered Applications',
          'Intelligent Systems',
          'Next-Gen AI',
        ]}
        description="Cut your AI costs by 40%. Eliminate vendor lock-in. Built for developers who demand more control over your LLM infrastructure."
        showWaitlist
        waitlistSource="hero"
      />

      <ProblemStatement />

      <SolutionOverview />

      <Features
        subtitle="Why Tanglement.ai"
        title="Key Features"
        features={features}
        columns={3}
        variant="default"
      />

      <CodeSamples />

      <NetworkStatus />

      <Testimonials
        variant="default"
        columns={3}
      />

      <TrustIndicators />

      <FAQ />

      <Footer />
    </>
  );
}
