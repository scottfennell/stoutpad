import mermaid from "mermaid";

const MERMAID_LANGUAGES = new Set(["mermaid", "mmd", "mindmap"]);

mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true });

export async function renderMermaidPreviews(root: ParentNode): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>(".code-block[data-language]");
  await Promise.all([...blocks].map((block) => renderMermaidPreviewForBlock(block)));
}

export async function renderMermaidPreviewForBlock(block: HTMLElement): Promise<void> {
  const language = block.dataset.language?.trim().toLowerCase() ?? "";
  const preview = block.querySelector<HTMLElement>(".code-block__preview");
  const code = block.querySelector<HTMLElement>("pre code");
  const pre = block.querySelector<HTMLElement>("pre[data-id]");
  if (!preview || !code || !pre) return;

  const text = code.textContent ?? "";
  preview.replaceChildren();

  if (!MERMAID_LANGUAGES.has(language) || text.trim() === "") {
    preview.hidden = true;
    delete preview.dataset.renderVersion;
    return;
  }

  preview.hidden = false;
  const version = String((Number(preview.dataset.renderVersion ?? "0") + 1) | 0);
  preview.dataset.renderVersion = version;

  try {
    const { svg } = await mermaid.render(pre.dataset.id ?? randomId(), text);
    if (preview.dataset.renderVersion !== version) return;
    preview.innerHTML = svg.trim();
  } catch (error) {
    if (preview.dataset.renderVersion !== version) return;
    preview.replaceChildren(renderError(error));
  }
}

function renderError(error: unknown): HTMLElement {
  const small = document.createElement("small");
  small.className = "code-block__preview-error";
  small.textContent = `Mermaid render error: ${error instanceof Error ? error.message : String(error)}`;

  const wrapper = document.createElement("p");
  wrapper.appendChild(small);
  return wrapper;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `m${crypto.randomUUID().slice(0, 8)}`;
  }
  return `m${Math.random().toString(36).slice(2, 10)}`;
}
