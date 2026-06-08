'use client';

import * as React from 'react';
import { Section, Container } from '@/components/layout';
import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import { useScrollAnimation } from '@/hooks/useScrollAnimation';

/**
 * CodeSamples Component
 *
 * Interactive code examples showing how to use Tanglement.ai SDK
 */

export interface CodeSample {
  language: string;
  label: string;
  code: string;
}

export interface CodeSamplesProps {
  title?: string;
  subtitle?: string;
  samples?: CodeSample[];
  className?: string;
}

const defaultSamples: CodeSample[] = [
  {
    language: 'typescript',
    label: 'TypeScript',
    code: `import { Tanglement } from '@tanglement/sdk';

// Initialize with your API keys
const tanglement = new Tanglement({
  providers: {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
  },
  routing: 'cost-optimized', // or 'performance' or 'reliability'
});

// Use just like OpenAI/Anthropic - drop-in replacement
const response = await tanglement.chat.completions.create({
  model: 'gpt-4', // Automatically routes to best provider
  messages: [
    { role: 'user', content: 'Explain quantum computing' }
  ],
});

console.log(response.choices[0].message.content);`,
  },
  {
    language: 'python',
    label: 'Python',
    code: `from tanglement import Tanglement

# Initialize with your API keys
tanglement = Tanglement(
    providers={
        "openai": os.getenv("OPENAI_API_KEY"),
        "anthropic": os.getenv("ANTHROPIC_API_KEY"),
        "google": os.getenv("GOOGLE_API_KEY"),
    },
    routing="cost-optimized",  # or "performance" or "reliability"
)

# Use just like OpenAI/Anthropic - drop-in replacement
response = tanglement.chat.completions.create(
    model="gpt-4",  # Automatically routes to best provider
    messages=[
        {"role": "user", "content": "Explain quantum computing"}
    ],
)

print(response.choices[0].message.content)`,
  },
  {
    language: 'go',
    label: 'Go',
    code: `package main

import (
    "context"
    "fmt"
    "os"

    "github.com/tanglement/go-sdk"
)

func main() {
    // Initialize with your API keys
    client := tanglement.NewClient(&tanglement.Config{
        Providers: map[string]string{
            "openai":    os.Getenv("OPENAI_API_KEY"),
            "anthropic": os.Getenv("ANTHROPIC_API_KEY"),
            "google":    os.Getenv("GOOGLE_API_KEY"),
        },
        Routing: "cost-optimized", // or "performance" or "reliability"
    })

    // Use just like OpenAI/Anthropic - drop-in replacement
    resp, err := client.Chat.Completions.Create(context.Background(), &tanglement.ChatRequest{
        Model: "gpt-4", // Automatically routes to best provider
        Messages: []tanglement.Message{
            {Role: "user", Content: "Explain quantum computing"},
        },
    })

    if err != nil {
        panic(err)
    }

    fmt.Println(resp.Choices[0].Message.Content)
}`,
  },
];

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group card-3d">
      {/* Glow effect on hover */}
      <div className="absolute -inset-0.5 bg-gradient-to-r from-brand-primary via-brand-accent to-brand-secondary rounded-lg opacity-0 group-hover:opacity-30 blur transition-opacity duration-500" />

      <div className="relative">
        {/* Copy Button */}
        <button
          onClick={handleCopy}
          className="absolute top-4 right-4 p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-all opacity-0 group-hover:opacity-100 z-10"
          aria-label="Copy code"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-400" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>

        {/* Code Content */}
        <pre className="overflow-x-auto p-6 bg-gray-950 border border-gray-800 group-hover:border-brand-accent/50 rounded-lg text-sm leading-relaxed transition-all duration-500">
          <code className="text-gray-100 font-mono">{code}</code>
        </pre>
      </div>
    </div>
  );
}

export function CodeSamples({
  title = 'Simple. Powerful. Developer-First.',
  subtitle = 'Get Started in Minutes',
  samples = defaultSamples,
  className,
}: CodeSamplesProps) {
  const [activeTab, setActiveTab] = React.useState(0);
  const { ref: headerRef, isVisible: headerVisible } = useScrollAnimation({ threshold: 0.2 });
  const { ref: tabsRef, isVisible: tabsVisible } = useScrollAnimation({ threshold: 0.2, delay: 100 });
  const { ref: codeRef, isVisible: codeVisible } = useScrollAnimation({ threshold: 0.2, delay: 200 });
  const { ref: featuresRef, isVisible: featuresVisible } = useScrollAnimation({ threshold: 0.2, delay: 300 });

  return (
    <Section spacing="xl" variant="dark" className={cn('relative overflow-hidden', className)}>
      {/* Background Gradient with mesh */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand-primary/10 via-transparent to-brand-accent/10 pointer-events-none" />
      <div className="absolute inset-0 gradient-mesh opacity-30 pointer-events-none" />

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
          <h2 className="text-4xl font-bold text-white mb-4">{title}</h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            Drop-in replacement for OpenAI, Anthropic, and Google. Same API, better reliability, lower
            costs.
          </p>
        </div>

        {/* Tabs */}
        <div
          ref={tabsRef}
          className={cn(
            'flex justify-center gap-2 mb-6 transition-all duration-700',
            tabsVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          {samples.map((sample, index) => (
            <button
              key={index}
              onClick={() => setActiveTab(index)}
              className={cn(
                'px-6 py-3 rounded-lg font-medium transition-all duration-300',
                activeTab === index
                  ? 'bg-brand-accent text-white shadow-lg shadow-brand-accent/20 scale-105'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300 hover:scale-105'
              )}
            >
              {sample.label}
            </button>
          ))}
        </div>

        {/* Code Display */}
        <div
          ref={codeRef}
          className={cn(
            'max-w-4xl mx-auto transition-all duration-700',
            codeVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          <CodeBlock code={samples[activeTab].code} language={samples[activeTab].language} />
        </div>

        {/* Features Grid */}
        <div
          ref={featuresRef}
          className={cn(
            'mt-16 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto transition-all duration-700',
            featuresVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          )}
        >
          <div className="p-6 rounded-lg bg-gray-900/50 border border-gray-800">
            <div className="text-brand-accent text-2xl font-bold mb-2">100%</div>
            <div className="text-white font-semibold mb-1">API Compatible</div>
            <div className="text-sm text-gray-400">
              Drop-in replacement for existing OpenAI/Anthropic code
            </div>
          </div>

          <div className="p-6 rounded-lg bg-gray-900/50 border border-gray-800">
            <div className="text-brand-accent text-2xl font-bold mb-2">&lt; 5min</div>
            <div className="text-white font-semibold mb-1">Setup Time</div>
            <div className="text-sm text-gray-400">
              Install, configure keys, start saving on costs immediately
            </div>
          </div>

          <div className="p-6 rounded-lg bg-gray-900/50 border border-gray-800">
            <div className="text-brand-accent text-2xl font-bold mb-2">0</div>
            <div className="text-white font-semibold mb-1">Code Changes</div>
            <div className="text-sm text-gray-400">
              Same interface, same parameters, zero refactoring required
            </div>
          </div>
        </div>

        {/* Coming Soon Badge */}
        <div className="mt-12 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-brand-accent/10 border border-brand-accent/30">
            <span className="h-2 w-2 rounded-full bg-brand-accent animate-pulse" />
            <span className="text-sm font-medium text-brand-accent">
              Private Beta • Early 2026
            </span>
          </div>
        </div>
      </Container>
    </Section>
  );
}
