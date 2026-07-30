import { marked } from "marked";

/**
 * Task bodies and run logs are markdown (§7.2/§7.3). Rendered read-only from
 * files inside the user's own workspace, served over loopback.
 */
export default function Markdown({ source }: { source: string }) {
  const html = marked.parse(source, { async: false, gfm: true }) as string;
  return (
    <div
      className="prose-awo text-sm leading-relaxed [&_code]:font-mono [&_code]:text-xs
        [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-ink/55
        [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold
        [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5
        [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-wash/70 [&_pre]:p-3
        [&_blockquote]:border-l-2 [&_blockquote]:border-moss/35 [&_blockquote]:pl-3 [&_blockquote]:text-ink/55"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
