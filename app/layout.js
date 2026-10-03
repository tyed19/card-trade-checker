import './globals.css';

export const metadata = {
  title: 'Card Trade Checker',
  description: 'Take a picture of two cards. Find out if the trade is fair!',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
