/**
 * The wikilink editor decoration.
 *
 * A TipTap/ProseMirror {@link Extension} that paints `[[wikilinks]]` in the live
 * document: it scans each text node for links ({@link scanWikiLinks}), resolves
 * each target through an injected resolver, and adds an inline {@link Decoration}
 * carrying a CSS class (`wikilink`, or `wikilink wikilink-broken` for a dangling
 * link) plus `data-wikilink-target` / `data-wikilink-path` attributes. The
 * literal `[[…]]` text is untouched (so Markdown still round-trips); only its
 * appearance and the data attributes the click handler reads are added.
 *
 * The resolver is read fresh on every rebuild via `getResolve`, so a late-arriving
 * note tree (or a navigation) re-evaluates broken state. {@link refreshWikiLinkDecorations}
 * forces a rebuild when the resolver changes without the document changing.
 */

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { scanWikiLinks } from "./editor.js";

/** Resolve a wikilink target (note title) to a note `path`, or `null` if broken. */
type Resolve = (target: string) => string | null;

/** Plugin key for the wikilink decoration set (also used to force a rebuild). */
export const WIKILINK_PLUGIN_KEY = new PluginKey<DecorationSet>("wikiLinkDecoration");

function buildDecorations(doc: ProseMirrorNode, resolve: Resolve): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || typeof node.text !== "string") return;
    for (const match of scanWikiLinks(node.text)) {
      const path = resolve(match.link.target);
      const attrs: Record<string, string> = {
        class: path === null ? "wikilink wikilink-broken" : "wikilink",
        "data-wikilink-target": match.link.target,
      };
      if (path !== null) attrs["data-wikilink-path"] = path;
      decorations.push(Decoration.inline(pos + match.start, pos + match.end, attrs));
    }
  });
  return DecorationSet.create(doc, decorations);
}

export interface WikiLinkDecorationOptions {
  /** Returns the current resolver; read on every (re)build so it can change. */
  getResolve: () => Resolve;
}

export const WikiLinkDecoration = Extension.create<WikiLinkDecorationOptions>({
  name: "wikiLinkDecoration",

  addOptions() {
    return { getResolve: () => () => null };
  },

  addProseMirrorPlugins() {
    const getResolve = this.options.getResolve;
    return [
      new Plugin<DecorationSet>({
        key: WIKILINK_PLUGIN_KEY,
        state: {
          init: (_config, state) => buildDecorations(state.doc, getResolve()),
          apply: (tr, value) =>
            tr.docChanged || tr.getMeta(WIKILINK_PLUGIN_KEY) === true
              ? buildDecorations(tr.doc, getResolve())
              : value,
        },
        props: {
          decorations(state: EditorState) {
            return WIKILINK_PLUGIN_KEY.getState(state);
          },
        },
      }),
    ];
  },
});

/**
 * Force the wikilink decorations to recompute — used when the resolver changes
 * (e.g. the note tree finished loading) but the document did not.
 */
export function refreshWikiLinkDecorations(editor: Editor): void {
  const { view } = editor;
  view.dispatch(view.state.tr.setMeta(WIKILINK_PLUGIN_KEY, true));
}
