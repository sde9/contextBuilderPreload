import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Context Builder — Enabler',
  description: 'Live visual context building. Green is what you said. Orange is what the AI guessed.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
