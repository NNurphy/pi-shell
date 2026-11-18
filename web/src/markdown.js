// pi-shell · T-08：最小 Markdown → DOM 渲染器（03 §14.1 的 ①~⑦ 子集）
// 硬约束：只用 DOM API 与 textContent 组装，**绝不拼 innerHTML**（消息正文可能含任意字符）。
// 不做语法高亮（F-02 不要求）；表格只做最小 GFM 子集（无对齐/无内嵌列表）。

const SAFE_HREF = /^(https?:\/\/|#|\/|\.\/|\.\.\/)/i;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** 行内：`code` / [text](url) / **bold** / *em* */
export function renderInline(text, parent) {
  const out = parent;
  let i = 0;
  const pushText = (s) => {
    if (s) out.appendChild(document.createTextNode(s));
  };
  while (i < text.length) {
    const rest = text.slice(i);
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      out.appendChild(el("code", "md-code", code[0].slice(1, -1)));
      i += code[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const [, label, href] = link;
      if (SAFE_HREF.test(href)) {
        const a = el("a", "md-link", label);
        a.href = href;
        a.rel = "noreferrer noopener";
        out.appendChild(a);
      } else {
        pushText(link[0]); // 不安全协议（javascript: 等）原样当文本
      }
      i += link[0].length;
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold) {
      out.appendChild(el("strong", "md-bold", bold[1]));
      i += bold[0].length;
      continue;
    }
    const em = /^\*([^*]+)\*/.exec(rest);
    if (em) {
      out.appendChild(el("em", "md-em", em[1]));
      i += em[0].length;
      continue;
    }
    pushText(text[i]);
    i += 1;
  }
  return out;
}

const isTableSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");
const splitRow = (line) =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((s) => s.trim());

export function renderMarkdown(markdown) {
  const frag = document.createDocumentFragment();
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const body = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i += 1; // 跳过结束围栏
      const wrap = el("div", "code-block");
      wrap.dataset.role = "code-block";
      if (lang) {
        const label = el("div", "code-lang", lang);
        label.dataset.role = "code-lang";
        wrap.appendChild(label);
      }
      const pre = el("pre", "code-pre");
      const code = el("code", "code-body", body.join("\n"));
      if (lang) code.dataset.lang = lang;
      pre.appendChild(code);
      wrap.appendChild(pre);
      frag.appendChild(wrap);
      continue;
    }

    // 表格（表头 + 分隔行）
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const table = el("table", "md-table");
      table.dataset.role = "table";
      const thead = el("thead");
      const htr = el("tr");
      for (const cell of splitRow(line)) htr.appendChild(el("th", null, cell));
      thead.appendChild(htr);
      table.appendChild(thead);
      i += 2;
      const tbody = el("tbody");
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const tr = el("tr");
        for (const cell of splitRow(lines[i])) {
          const td = el("td");
          renderInline(cell, td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i += 1;
      }
      table.appendChild(tbody);
      frag.appendChild(table);
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const h = el(`h${Math.min(level, 6)}`, `md-h${level}`);
      h.dataset.role = "heading";
      renderInline(heading[2], h);
      frag.appendChild(h);
      i += 1;
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const quote = el("blockquote", "md-quote");
      quote.dataset.role = "blockquote";
      const inner = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) inner.push(lines[i++].replace(/^>\s?/, ""));
      renderMarkdown(inner.join("\n")).childNodes.forEach((n) => quote.appendChild(n));
      frag.appendChild(quote);
      continue;
    }

    // 列表（连续同类行）
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const list = el(ordered ? "ol" : "ul", ordered ? "md-ol" : "md-ul");
      list.dataset.role = ordered ? "ol" : "ul";
      const re = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      while (i < lines.length && re.test(lines[i])) {
        const li = el("li");
        renderInline(lines[i].replace(re, ""), li);
        list.appendChild(li);
        i += 1;
      }
      frag.appendChild(list);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 段落（连续非空行）
    const para = el("p", "md-p");
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    renderInline(buf.join("\n"), para);
    frag.appendChild(para);
  }

  return frag;
}
