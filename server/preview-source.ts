const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function previewSource(source: string, filename: string, line?: number) {
  const lines = source.split(/\r\n?|\n/);
  const target = line === undefined ? undefined : lines[line - 1];
  const code = lines
    .map((text, index) => {
      const escaped = escape(text);
      return index + 1 === line
        ? `<mark id="L${line}">${escaped}</mark>`
        : escaped;
    })
    .join("\n");
  const numbers = lines.map((_, index) => index + 1).join("\n");
  const notice =
    line !== undefined && target === undefined
      ? `<p>Line ${line} is outside this file.</p>`
      : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(filename)}</title><style>
    :root {
      color-scheme: dark;
      scroll-padding-top: 25vh;
    }
    body {
      margin: 0;
      background: #18181b;
      color: #e4e4e7;
    }
    main {
      display: grid;
      grid-template-columns: max-content 1fr;
      width: max-content;
      min-width: 100%;
    }
    pre {
      margin: 0;
      padding: 12px 0;
      font: 13px/22px ui-monospace, SFMono-Regular, Consolas, monospace;
      tab-size: 4;
    }
    .numbers {
      position: sticky;
      left: 0;
      z-index: 1;
      padding-inline: 12px;
      border-right: 1px solid #3f3f46;
      background: #202023;
      color: #a1a1aa;
      text-align: right;
      user-select: none;
    }
    .source { padding-inline: 12px; }
    mark {
      display: inline-block;
      min-width: 100%;
      min-height: 1lh;
      vertical-align: top;
      scroll-margin-inline-start: 12ch;
      background: #243247;
      color: inherit;
      box-shadow: -3px 0 #8bb8f0;
    }
    p {
      box-sizing: border-box;
      width: 100vw;
      margin: 0;
      padding: 10px 12px;
      background: #202023;
      font: 13px/1.5 system-ui, sans-serif;
    }
  </style>${notice}<main><pre class="numbers" aria-hidden="true">${numbers}</pre><pre class="source"><code>${code}</code></pre></main></html>`;
}
