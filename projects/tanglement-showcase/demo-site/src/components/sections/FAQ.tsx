import * as Accordion from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface FAQItem {
  question: string;
  answer: string;
}

export interface FAQProps {
  title?: string;
  subtitle?: string;
  items?: FAQItem[];
  type?: 'single' | 'multiple';
  className?: string;
}

const defaultFAQItems: FAQItem[] = [
  {
    question: 'What is Tanglement.ai?',
    answer:
      'Tanglement.ai is a decentralized routing layer for LLM access that connects you to multiple AI providers (OpenAI, Anthropic, Google, and more) through a single interface. By routing requests intelligently across providers, we reduce costs by 20-40% while eliminating vendor lock-in and ensuring your API keys never leave your device.',
  },
  {
    question: 'How much can I save?',
    answer:
      'Most users save 20-40% on their LLM access costs compared to using a single provider directly. Savings come from intelligent multi-provider routing, automatic failover to lower-cost providers when quality is equivalent, and elimination of vendor markup. The exact savings depend on your usage patterns and tier selection.',
  },
  {
    question: 'Is my data private?',
    answer:
      'Absolutely. Tanglement.ai uses client-side routing, which means all routing decisions happen on your device—not our servers. Your API keys never leave your infrastructure, and your requests go directly to the LLM providers. We cannot see your prompts, responses, or API credentials. Privacy is built into the architecture, not added as a feature.',
  },
  {
    question: 'Which LLM providers are supported?',
    answer:
      'We currently support OpenAI (GPT-4, GPT-3.5), Anthropic (Claude 3.5 Sonnet, Claude 3 Opus), Google (Gemini Pro, Gemini Ultra), and are actively adding more providers. Our architecture is provider-agnostic, so you can easily switch between providers or use multiple providers simultaneously for different use cases.',
  },
  {
    question: 'What are the three tiers?',
    answer:
      'We offer three tiers to match different priorities: Premium Reliability (99.9% uptime SLA, multi-provider redundancy, ideal for production systems), Premium Performance (optimized for lowest latency, best for real-time applications), and Economy Pricing (maximize cost savings, perfect for research and batch processing). You choose exactly one tier based on your application needs.',
  },
  {
    question: 'When will it launch?',
    answer:
      'We\'re targeting early 2026 for our public launch. We\'re currently in private alpha testing with select partners to refine the platform and ensure enterprise-grade reliability. Join our waitlist to be among the first to access the beta program and get early adopter benefits including discounted pricing and priority support.',
  },
];

export function FAQ({
  title = 'Frequently Asked Questions',
  subtitle = 'Everything you need to know',
  items = defaultFAQItems,
  type = 'single',
  className,
}: FAQProps) {
  return (
    <section
      id="faq"
      className={cn('w-full bg-transparent py-24', className)}
    >
      <div className="container mx-auto max-w-4xl px-6">
        {/* Header */}
        <div className="mb-16 text-left">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-accent">
            {subtitle}
          </p>
          <h2 className="text-4xl font-bold text-gray-900 dark:text-gray-50">
            {title}
          </h2>
        </div>

        {/* FAQ Accordion */}
        {type === 'single' ? (
          <Accordion.Root
            type="single"
            defaultValue="item-0"
            className="space-y-4"
          >
            {items.map((item, index) => (
              <Accordion.Item
                key={index}
                value={`item-${index}`}
                className="card-surface overflow-hidden rounded-lg transition-colors hover:border-brand-accent/40"
              >
                <Accordion.Header>
                  <Accordion.Trigger className="group flex w-full items-center justify-between px-6 py-5 text-left font-medium transition-all hover:bg-white/5">
                    <span className="text-lg text-gray-100">
                      {item.question}
                    </span>
                    <ChevronDown
                      className="h-5 w-5 text-gray-500 transition-transform duration-200 group-data-[state=open]:rotate-180 dark:text-gray-400"
                      aria-hidden="true"
                    />
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
                  <div className="px-6 pb-5 pt-2 text-gray-600 dark:text-gray-300">
                    <p className="leading-relaxed">{item.answer}</p>
                  </div>
                </Accordion.Content>
              </Accordion.Item>
            ))}
          </Accordion.Root>
        ) : (
          <Accordion.Root
            type="multiple"
            className="space-y-4"
          >
          {items.map((item, index) => (
            <Accordion.Item
              key={index}
              value={`item-${index}`}
              className="card-surface overflow-hidden rounded-lg transition-all hover:border-brand-accent/40 hover:shadow-md"
            >
              <Accordion.Header className="flex">
                <Accordion.Trigger className="group flex w-full items-center justify-between px-6 py-5 text-left transition-colors hover:bg-white/5">
                  <span className="text-lg font-semibold text-gray-50">
                    {item.question}
                  </span>
                  <ChevronDown
                    className="h-5 w-5 shrink-0 text-gray-500 transition-transform duration-300 group-data-[state=open]:rotate-180 dark:text-gray-400"
                    aria-hidden="true"
                  />
                </Accordion.Trigger>
              </Accordion.Header>

              <Accordion.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
                <div className="px-6 pb-5 pt-2">
                  <p className="text-gray-600 leading-relaxed dark:text-gray-400">
                    {item.answer}
                  </p>
                </div>
              </Accordion.Content>
            </Accordion.Item>
          ))}
          </Accordion.Root>
        )}

        {/* CTA */}
        <div className="mt-12 text-left">
          <p className="text-gray-600 dark:text-gray-400">
            Still have questions?{' '}
            <a
              href="mailto:hello@tanglement.ai"
              className="font-semibold text-accent hover:underline"
            >
              Contact us
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
