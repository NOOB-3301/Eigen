import type { Metadata } from 'next';
import './globals.css';
import { OrchestratorProvider } from '@/context/orchestrator';

export const metadata: Metadata = {
  title: 'Eigen Studio',
  description: 'Multi-agent orchestration platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased">
        <OrchestratorProvider>
          {children}
        </OrchestratorProvider>
      </body>
    </html>
  );
}
