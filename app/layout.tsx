import "./globals.css";

export const metadata = {
  title: "LGU Malungon QR Attendance Tracker",
  description: "QR Attendance Tracker",

  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },

  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="header">
          <div className="header-left">
            <img
              src="/lgu-logo.png"
              alt="LGU Malungon Logo"
              className="header-logo"
            />
            <div className="header-title">
              LGU Malungon QR Attendance Tracker
            </div>
          </div>
        </header>

        <main className="main">{children}</main>

        <footer className="footer">
          LGU Malungon © 2026 created by MIO
        </footer>
      </body>
    </html>
  );
}
