"use client";

import { useEffect, useMemo } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
} from "lucide-react";

import { createCollab, type CollabUser, type CollabTicket } from "@/lib/collab/provider";
import { SlashCommand } from "./slash-menu";
import { cn } from "./ui";

const ANON: CollabUser = { name: "Anonymous", color: "#3b82f6" };

// tiptap-markdown adds `storage.markdown` at runtime but doesn't ship the TS
// augmentation, so we read it through a narrow typed accessor.
type MarkdownStorage = { markdown: { getMarkdown: () => string } };
function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as MarkdownStorage).markdown.getMarkdown();
}

// WYSIWYG surface (TipTap/ProseMirror) that round-trips Markdown via tiptap-
// markdown. The editor's getMarkdown() is the value; the parent owns the canonical
// string, and Save runs it through the canonical serializer at the commit boundary
// (architecture.md §3) — so WYSIWYG output stays diff-clean regardless.
export function Wysiwyg({
  value,
  onChange,
  ticket,
  user,
}: {
  value: string;
  onChange: (markdown: string) => void;
  ticket?: CollabTicket;
  user?: CollabUser;
}) {
  // Live collaboration is optional and OFF by default: it engages only when the
  // parent supplies a server-minted per-doc ticket (architecture.md §3b). Build
  // the Y.Doc + provider once, client-side only (SSR-safe).
  const collab = useMemo(() => {
    if (!ticket) return null;
    return createCollab(ticket, user ?? ANON);
  }, [ticket, user]);

  // Tear the websocket down when the room changes or the component unmounts.
  useEffect(() => {
    if (!collab) return;
    return () => {
      collab.provider.destroy();
      collab.ydoc.destroy();
    };
  }, [collab]);

  const editor = useEditor(
    {
      immediatelyRender: false, // required under Next SSR
      extensions: collab
        ? [
            // Collaboration provides its own undo/redo, so StarterKit's must be off.
            StarterKit.configure({ undoRedo: false }),
            Markdown.configure({ html: false, transformPastedText: true }),
            // The "/" command menu is a schema-agnostic extension, so it rides along
            // unchanged in both collab and non-collab modes.
            SlashCommand,
            Collaboration.configure({ document: collab.ydoc }),
            CollaborationCaret.configure({
              provider: collab.provider,
              user: user ?? ANON,
            }),
          ]
        : [
            StarterKit,
            Markdown.configure({ html: false, transformPastedText: true }),
            SlashCommand,
          ],
      // With collaboration the shared Y.Doc is the source of truth, so we seed it
      // separately (below) rather than via the editor's initial content.
      content: collab ? "" : value,
      editorProps: {
        attributes: { class: "prose-doc min-h-[55vh] focus:outline-none" },
      },
      onUpdate: ({ editor }) => onChange(getMarkdown(editor)),
    },
    [collab],
  );

  // Seed the shared doc from the incoming markdown ONLY if the Y.Doc is still empty
  // on first connect — otherwise a late joiner would clobber existing collaborators.
  useEffect(() => {
    if (!editor || !collab) return;
    const seed = () => {
      const empty = editor.state.doc.content.size <= 2; // just the default empty paragraph
      if (empty && value) {
        editor.commands.setContent(value, { emitUpdate: false });
      }
    };
    if (collab.provider.synced) {
      seed();
    } else {
      collab.provider.once("sync", (isSynced: boolean) => {
        if (isSynced) seed();
      });
    }
    // value intentionally read once at connect time; resyncing on every keystroke
    // would fight the CRDT.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, collab]);

  // Reflect external value changes (e.g. accepting an AI proposal) without looping:
  // only reset when the incoming markdown differs from what the editor would emit.
  // Skipped under collaboration, where the shared Y.Doc owns the content.
  useEffect(() => {
    if (!editor || collab) return;
    if (value !== getMarkdown(editor)) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor, collab]);

  if (!editor) return null;

  return (
    <div className="glass overflow-hidden">
      <Toolbar editor={editor} />
      <div className="p-5">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const btn = (active: boolean) =>
    cn(
      "rounded px-2 py-1 text-sm text-[--color-muted] hover:bg-[--color-accent]/10 hover:text-[--color-ink]",
      active && "bg-[--color-accent]/15 text-[--color-accent]",
    );
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-[--color-line] px-2 py-1.5">
      <button type="button" aria-label="Bold" className={btn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={15} />
      </button>
      <button type="button" aria-label="Italic" className={btn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={15} />
      </button>
      <button type="button" aria-label="Heading 1" className={btn(editor.isActive("heading", { level: 1 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 size={15} />
      </button>
      <button type="button" aria-label="Heading 2" className={btn(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={15} />
      </button>
      <button type="button" aria-label="Bullet list" className={btn(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={15} />
      </button>
      <button type="button" aria-label="Ordered list" className={btn(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered size={15} />
      </button>
      <button type="button" aria-label="Quote" className={btn(editor.isActive("blockquote"))} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote size={15} />
      </button>
      <button type="button" aria-label="Code block" className={btn(editor.isActive("codeBlock"))} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <Code size={15} />
      </button>
    </div>
  );
}
