/**
 * TipTap implementation of the {@link EditorComponent} seam.
 *
 * A thin React shell over TipTap/ProseMirror: it loads the note's canonical
 * Markdown (via {@link markdownToTipTapDoc}), renders it with live WYSIWYG
 * formatting and checkbox task lists, and reports edits back as Markdown (via
 * {@link tipTapDocToMarkdown}). All Markdown ↔ document conversion lives in the
 * pure `./editor` bridge; this file only owns the editor lifecycle. The seam keeps
 * TipTap swappable, so `@stout/core` never learns about ProseMirror or the DOM.
 */

import { useEffect, type ReactElement } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import {
  markdownToTipTapDoc,
  tipTapDocToMarkdown,
  type EditorProps,
} from "./editor.js";

const EXTENSIONS = [StarterKit, TaskList, TaskItem.configure({ nested: true })];

export function TipTapEditor({
  markdown,
  onChange,
  editable = true,
}: EditorProps): ReactElement {
  const editor = useEditor({
    editable,
    extensions: EXTENSIONS,
    content: markdownToTipTapDoc(markdown),
    onUpdate: ({ editor }) => onChange?.(tipTapDocToMarkdown(editor.getJSON())),
  });

  // Swap in the newly selected note when the markdown prop changes, without
  // re-emitting an update for content we just loaded.
  useEffect(() => {
    if (!editor) return;
    if (tipTapDocToMarkdown(editor.getJSON()).trim() === markdown.trim()) return;
    editor.commands.setContent(markdownToTipTapDoc(markdown), {
      emitUpdate: false,
    });
  }, [editor, markdown]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return (
    <div data-testid="note-editor" className="note-editor">
      <EditorContent editor={editor} />
    </div>
  );
}
