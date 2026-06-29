"use client";

// Root error boundary: catches client-side exceptions anywhere (including the
// root layout / providers) so the app shows the actual error instead of a blank
// "Application error" screen. Most often this is a backend/auth misconfig
// (e.g. a missing Clerk "convex" JWT template, or an unreachable Convex URL).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: 680,
          margin: "0 auto",
          padding: "48px 24px",
          color: "#111",
        }}
      >
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>
          trueline hit a client-side error
        </h1>
        <p style={{ color: "#666", fontSize: 14, marginBottom: 16 }}>
          This is usually a backend/auth configuration issue (e.g. a missing
          Clerk &ldquo;convex&rdquo; JWT template or an unreachable Convex URL).
          The details:
        </p>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "#f6f6f6",
            border: "1px solid #e5e5e5",
            borderRadius: 8,
            padding: 14,
            fontSize: 13,
            overflowX: "auto",
          }}
        >
          {error?.message || String(error)}
          {error?.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>
        <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
          <button
            onClick={() => reset()}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #ccc",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <a href="/" style={{ padding: "8px 16px", color: "#2563eb" }}>
            Back to home
          </a>
        </div>
      </body>
    </html>
  );
}
