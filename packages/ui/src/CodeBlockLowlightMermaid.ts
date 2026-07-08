import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import type { NodeViewProps } from "@tiptap/core";
import { renderMermaidPreviewForBlock } from "./mermaid-preview.js";
export const MermaidCodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      id: {
        default: () => randomId(),
        parseHTML: (element: HTMLElement) => element.getAttribute("data-id") || randomId(),
        renderHTML: (attributes: { id?: string }) =>
          attributes.id ? { "data-id": attributes.id } : {},
      },
    };
  },

  addNodeView() {
    return (props) => createCodeBlockView(props as NodeViewProps);
  },
});

function createCodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const dom = document.createElement("figure");
  dom.className = "code-block";

  const header = document.createElement("figcaption");
  header.className = "code-block__header";

  const controls = document.createElement("div");
  controls.className = "code-block__controls";

  const languageBadge = document.createElement("span");
  languageBadge.className = "code-block__language";

  const languageInput = document.createElement("input");
  languageInput.className = "code-block__language-input";
  languageInput.type = "text";
  languageInput.placeholder = "plain text";
  languageInput.spellcheck = false;

  const collapseButton = document.createElement("button");
  collapseButton.className = "code-block__toggle";
  collapseButton.type = "button";

  header.append(languageBadge, controls);
  controls.append(languageInput, collapseButton);

  const body = document.createElement("div");
  body.className = "code-block__body";

  const lineNumbers = document.createElement("div");
  lineNumbers.className = "code-block__line-numbers";
  lineNumbers.setAttribute("aria-hidden", "true");

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.spellcheck = false;
  pre.appendChild(code);

  body.append(lineNumbers, pre);

  const preview = document.createElement("div");
  preview.className = "code-block__preview";
  preview.hidden = true;

  dom.append(header, body, preview);

  let currentNode = node;
  let collapsed = false;
  let previewFrame: number | null = null;

  const schedulePreview = (): void => {
    if (previewFrame !== null) cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(() => {
      previewFrame = null;
      void renderMermaidPreviewForBlock(dom);
    });
  };

  const syncCollapsed = (): void => {
    body.hidden = collapsed;
    collapseButton.textContent = collapsed ? "Show code" : "Hide code";
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
  };

  const commitLanguage = (): void => {
    const next = normalizeLanguage(languageInput.value);
    const current = normalizeLanguage(currentNode.attrs.language);
    if (next === current) return;
    updateAttributes({ language: next === "" ? null : next });
  };

  languageInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      commitLanguage();
      languageInput.blur();
    }
  });
  languageInput.addEventListener("blur", commitLanguage);

  collapseButton.addEventListener("mousedown", (event) => event.preventDefault());
  collapseButton.addEventListener("click", () => {
    collapsed = !collapsed;
    syncCollapsed();
  });

  const sync = (): void => {
    const language = normalizeLanguage(currentNode.attrs.language);
    const id = typeof currentNode.attrs.id === "string" ? currentNode.attrs.id : randomId();

    dom.dataset.language = language;
    pre.dataset.id = id;
    languageBadge.textContent = language === "" ? "plain text" : language;
    if (document.activeElement !== languageInput) languageInput.value = language;
    code.className = language === "" ? "" : `language-${language}`;
    lineNumbers.textContent = lineNumberText(currentNode.textContent);
    syncCollapsed();
    schedulePreview();
  };

  sync();

  return {
    dom,
    contentDOM: code,
    update(updatedNode: typeof node) {
      if (updatedNode.type !== currentNode.type) return false;
      currentNode = updatedNode;
      sync();
      return true;
    },
    destroy() {
      if (previewFrame !== null) cancelAnimationFrame(previewFrame);
    },
  };
}

function normalizeLanguage(language: unknown): string {
  return typeof language === "string" ? language.trim().toLowerCase() : "";
}

function lineNumberText(text: string): string {
  const lineCount = Math.max(1, text.split("\n").length);
  return Array.from({ length: lineCount }, (_, index) => `${index + 1}`).join("\n");
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `m${crypto.randomUUID().slice(0, 8)}`;
  }
  return `m${Math.random().toString(36).slice(2, 10)}`;
}
