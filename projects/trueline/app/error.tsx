"use client";

// Page-level error boundary (everything under the root layout). Renders the real
// error message + a retry instead of a blank "Application error" screen.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 680,
        margin: "0 auto",
        padding: "48px 24px",
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>Couldn&apos;t load this page</h2>
      <p style={{ color: "#666", fontSize: 14, marginBottom: 16 }}>
        A client-side error occurred. Details:
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
    </main>
  );
}
