/**
 * TipTap implementation of the {@link EditorComponent} seam.
 *
 * A thin React shell over TipTap/ProseMirror: it loads the note's canonical
 * Markdown (via {@link markdownToTipTapDoc}), renders it with live WYSIWYG
 * formatting and checkbox task lists, and reports edits back as Markdown (via
 * {@link tipTapDocToMarkdown}). All Markdown ↔ document conversion lives in the
 * pure `./editor` bridge; this file only owns the editor lifecycle. The seam keeps
 * TipTap swappable, so `@stout/core` never learns about ProseMirror or the DOM.
 *
 * On top of that it renders **wikilinks**: a ProseMirror decoration underlines
 * `[[links]]` (dashed + red when broken), clicking a resolved link navigates, and
 * typing `[[` opens a title autocomplete. The link semantics come from the
 * injected {@link WikiLinkContext}; the editor only renders and dispatches them.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import {
  filterTitles,
  markdownToTipTapDoc,
  tipTapDocToMarkdown,
  wikiLinkQuery,
  type EditorProps,
} from "./editor.js";
import {
  WikiLinkDecoration,
  refreshWikiLinkDecorations,
} from "./wikilink-decoration.js";

const BASE_EXTENSIONS = [
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
];

/** Inject the wikilink styles once, the first time an editor mounts. */
const WIKILINK_STYLE_ID = "stout-wikilink-style";
function ensureWikiLinkStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(WIKILINK_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = WIKILINK_STYLE_ID;
  // Technical Umber (DESIGN.md / ADR 0009): resolved links take the tertiary
  // "interactive accent" blue; broken links take the error red. Hardcoded (not
  // CSS vars) so the styles stand alone even if the theme sheet is absent.
  style.textContent = [
    ".wikilink{color:#a6caff;cursor:pointer;border-bottom:1px solid rgba(166,202,255,.45)}",
    ".wikilink-broken{color:#ffb4ab;border-bottom:1px dashed #ffb4ab}",
  ].join("");
  document.head.appendChild(style);
}

/** Live `[[` autocomplete state: the suggestions and where to insert the pick. */
interface SuggestState {
  /** Ranked title suggestions for the current query. */
  items: string[];
  /** Doc position of the opening `[[`, where the inserted link replaces from. */
  from: number;
  /** Viewport coordinates to anchor the popup near the caret. */
  coords: { left: number; top: number };
}

/** Compute the autocomplete state for the caret, or `null` when not in a `[[`. */
function computeSuggestState(editor: Editor, titles: string[]): SuggestState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  const query = wikiLinkQuery(textBefore);
  if (query === null) return null;
  const items = filterTitles(titles, query);
  if (items.length === 0) return null;
  const from = $from.start() + textBefore.lastIndexOf("[[");
  let coords = { left: 0, top: 0 };
  try {
    const c = editor.view.coordsAtPos(selection.from);
    coords = { left: c.left, top: c.bottom };
  } catch {
    // Detached view (e.g. jsdom has no layout): anchor at the origin.
  }
  return { items, from, coords };
}

/**
 * The `[[` autocomplete popup. Presentational and pure (no editor coupling) so it
 * can be unit-tested directly: it renders the ranked titles as a listbox and
 * calls {@link onPick} when one is chosen.
 */
export function WikiLinkSuggestions({
  items,
  activeIndex,
  onPick,
  coords,
}: {
  items: string[];
  activeIndex: number;
  onPick: (title: string) => void;
  coords?: { left: number; top: number };
}): ReactElement {
  return (
    <ul
      role="listbox"
      aria-label="Link suggestions"
      data-testid="wikilink-suggestions"
      style={{
        position: "fixed",
        left: coords?.left ?? 0,
        top: coords?.top ?? 0,
        margin: 0,
        padding: "0.25rem 0",
        listStyle: "none",
        background: "#1d2021",
        border: "1px solid #50453b",
        borderRadius: "0.25rem",
        color: "#e1e3e4",
        zIndex: 50,
        minWidth: "10rem",
      }}
    >
      {items.map((title, index) => (
        <li key={title} role="option" aria-selected={index === activeIndex}>
          <button
            type="button"
            // Use mousedown so the pick fires before the editor loses focus.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(title);
            }}
            style={{
              appearance: "none",
              background: index === activeIndex ? "#282a2b" : "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              display: "block",
              font: "inherit",
              padding: "0.2rem 0.6rem",
              textAlign: "left",
              width: "100%",
            }}
          >
            {title}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function TipTapEditor({
  markdown,
  onChange,
  editable = true,
  wikiLinks,
}: EditorProps): ReactElement {
  useEffect(ensureWikiLinkStyles, []);

  // Live mirrors of the wikilink context for the editor's fixed callbacks.
  const resolveRef = useRef<(target: string) => string | null>(() => null);
  resolveRef.current = wikiLinks?.resolve ?? (() => null);
  const titlesRef = useRef<string[]>([]);
  titlesRef.current = wikiLinks?.titles ?? [];

  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const suggestRef = useRef<SuggestState | null>(null);
  suggestRef.current = suggest;
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;
  const pickRef = useRef<(title: string) => void>(() => undefined);

  const refreshSuggest = useCallback((editor: Editor) => {
    const next = computeSuggestState(editor, titlesRef.current);
    setSuggest(next);
    setActiveIndex(0);
  }, []);

  // ProseMirror-level key handling for the open popup (idiomatic + non-fighting).
  const handleKeyDown = useCallback((_view: unknown, event: KeyboardEvent): boolean => {
    const state = suggestRef.current;
    if (state === null) return false;
    switch (event.key) {
      case "Escape":
        setSuggest(null);
        return true;
      case "ArrowDown":
        setActiveIndex((i) => (i + 1) % state.items.length);
        return true;
      case "ArrowUp":
        setActiveIndex((i) => (i - 1 + state.items.length) % state.items.length);
        return true;
      case "Enter":
        pickRef.current(state.items[activeIndexRef.current] ?? state.items[0]);
        return true;
      default:
        return false;
    }
  }, []);

  const extensions = useMemo(
    () => [
      ...BASE_EXTENSIONS,
      WikiLinkDecoration.configure({ getResolve: () => resolveRef.current }),
    ],
    [],
  );

  const editor = useEditor({
    editable,
    extensions,
    content: markdownToTipTapDoc(markdown),
    editorProps: { handleKeyDown },
    onUpdate: ({ editor }) => {
      onChange?.(tipTapDocToMarkdown(editor.getJSON()));
      refreshSuggest(editor);
    },
    onSelectionUpdate: ({ editor }) => refreshSuggest(editor),
  });

  // Insert the chosen title as a `[[link]]`, replacing the in-progress `[[query`.
  useEffect(() => {
    pickRef.current = (title: string): void => {
      const state = suggestRef.current;
      if (!editor || state === null) return;
      const to = editor.state.selection.from;
      editor
        .chain()
        .focus()
        .insertContentAt({ from: state.from, to }, `[[${title}]]`)
        .run();
      setSuggest(null);
    };
  }, [editor]);

  // Swap in the newly selected note when the markdown prop changes, without
  // re-emitting an update for content we just loaded.
  useEffect(() => {
    if (!editor) return;
    if (tipTapDocToMarkdown(editor.getJSON()).trim() === markdown.trim()) return;
    editor.commands.setContent(markdownToTipTapDoc(markdown), { emitUpdate: false });
    setSuggest(null);
  }, [editor, markdown]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // Re-evaluate broken/resolved state when the resolver changes (e.g. tree load).
  useEffect(() => {
    if (editor) refreshWikiLinkDecorations(editor);
  }, [editor, wikiLinks]);

  // Navigate when a resolved wikilink is clicked (broken links carry no path).
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      const el = (event.target as HTMLElement | null)?.closest?.(
        "[data-wikilink-target]",
      ) as HTMLElement | null;
      if (!el) return;
      const path = el.getAttribute("data-wikilink-path");
      if (path === null) return;
      event.preventDefault();
      wikiLinks?.onNavigate?.(path, el.getAttribute("data-wikilink-target") ?? "");
    },
    [wikiLinks],
  );

  return (
    <div
      data-testid="note-editor"
      className="note-editor"
      onClick={handleClick}
    >
      <EditorContent editor={editor} />
      {suggest !== null && (
        <WikiLinkSuggestions
          items={suggest.items}
          activeIndex={activeIndex}
          coords={suggest.coords}
          onPick={(title) => pickRef.current(title)}
        />
      )}
    </div>
  );
}
