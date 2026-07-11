"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Quote,
  Type,
  type LucideIcon,
} from "lucide-react";

// A single "/" command: what the user sees plus what it does. `command` gets the
// live editor and the range spanning the typed "/query", so it can wipe that text
// before applying the block transform (mirrors the toolbar chains in wysiwyg.tsx).
type SlashItem = {
  title: string;
  keywords: string;
  icon: LucideIcon;
  command: (props: { editor: Editor; range: Range }) => void;
};

// Only StarterKit-provided nodes are used here, so no extra schema/extensions are
// needed for the menu to work in either editor mode.
const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Text",
    keywords: "paragraph body plain",
    icon: Type,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: "Heading 1",
    keywords: "title h1 big",
    icon: Heading1,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run(),
  },
  {
    title: "Heading 2",
    keywords: "subtitle h2",
    icon: Heading2,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run(),
  },
  {
    title: "Heading 3",
    keywords: "h3",
    icon: Heading3,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run(),
  },
  {
    title: "Bulleted list",
    keywords: "unordered ul bullet point",
    icon: List,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    keywords: "ordered ol numbered",
    icon: ListOrdered,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "Blockquote",
    keywords: "quote citation",
    icon: Quote,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: "Code block",
    keywords: "code pre monospace",
    icon: Code2,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    keywords: "divider horizontal rule hr line separator",
    icon: Minus,
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) || item.keywords.includes(q),
  );
}

// Imperative handle the plugin's onKeyDown reaches through to drive selection from
// keystrokes ProseMirror still owns (arrows/enter), returning true when consumed.
type SlashMenuRef = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

const SlashMenuList = forwardRef<SlashMenuRef, SuggestionProps<SlashItem>>(
  function SlashMenuList({ items, command }, ref) {
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // Any change to the result set (new query) resets the highlight to the top.
    useEffect(() => setSelected(0), [items]);

    // Keep the highlighted row visible as arrow keys walk past the fold.
    useLayoutEffect(() => {
      const el = listRef.current?.children[selected] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    const pick = (index: number) => {
      const item = items[index];
      if (item) command(item);
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowUp") {
          setSelected((s) => (s + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          pick(selected);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="glass w-64 rounded-lg border border-[--color-line] p-2 text-sm text-[--color-muted] shadow-xl">
          No results
        </div>
      );
    }

    return (
      <div
        ref={listRef}
        className="glass max-h-72 w-64 overflow-y-auto rounded-lg border border-[--color-line] p-1 shadow-xl"
      >
        {items.map((item, index) => {
          const Icon = item.icon;
          const active = index === selected;
          return (
            <button
              type="button"
              key={item.title}
              onMouseEnter={() => setSelected(index)}
              onClick={() => pick(index)}
              className={
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm " +
                (active
                  ? "bg-[--color-accent]/15 text-[--color-accent]"
                  : "text-[--color-ink] hover:bg-[--color-accent]/10")
              }
            >
              <Icon size={16} className="shrink-0" />
              <span>{item.title}</span>
            </button>
          );
        })}
      </div>
    );
  },
);

// TipTap extension wiring `Suggestion` to the "/" char. The plugin owns detection,
// Escape/outside-click dismissal, and (via `mount`) floating-ui positioning; we only
// render the list and forward navigation keys. Works identically with or without
// collaboration since it's a plain schema-agnostic extension.
export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        command: ({ editor, range, props }) => props.command({ editor, range }),
        items: ({ query }) => filterItems(query),
        render: () => {
          let renderer: ReactRenderer<SlashMenuRef, SuggestionProps<SlashItem>>;
          let unmount: (() => void) | undefined;

          return {
            onStart: (props) => {
              renderer = new ReactRenderer(SlashMenuList, {
                props,
                editor: props.editor,
              });
              unmount = props.mount(renderer.element as HTMLElement);
            },
            onUpdate: (props) => {
              renderer?.updateProps(props);
            },
            onKeyDown: (props) => renderer?.ref?.onKeyDown(props) ?? false,
            onExit: () => {
              unmount?.();
              renderer?.destroy();
            },
          };
        },
      }),
    ];
  },
});
