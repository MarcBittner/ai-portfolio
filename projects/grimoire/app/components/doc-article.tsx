// Server-rendered doc body. NO "use client" — this renders on the server (in the
// RSC page) so the react-markdown + remark/rehype toolchain ships 0 KB to the
// browser for reading. The rendered HTML streams from the server; the client only
// hydrates the thin interactive chrome around it (doc-read-edit).
//
// Rendering must stay byte-for-byte equivalent to the previous client render:
// remark-gfm for GFM, rehype-sanitize for the XSS boundary, rehype-slug for the
// heading anchors that the on-page ToC scroll-spy targets.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";

/** Renders the (front-matter-stripped) Markdown body to sanitized, anchored HTML.
 *  Pure/stateless — safe to render as a Server Component. */
export function DocArticle({ body }: { body: string }) {
  return (
    <div className="prose-doc">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize, rehypeSlug]}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
