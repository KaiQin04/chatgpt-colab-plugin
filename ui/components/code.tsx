/** Code display and editing: one tag highlighter for static cells and CodeMirror. */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";

export const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], class: "tok-k" },
  { tag: [tags.definition(tags.variableName), tags.function(tags.definition(tags.variableName)), tags.className], class: "tok-d" },
  { tag: [tags.string, tags.special(tags.string)], class: "tok-s" },
  { tag: [tags.number, tags.bool, tags.null], class: "tok-n" },
  { tag: [tags.comment, tags.lineComment], class: "tok-c" },
]);

type Piece = { text: string; className: string } | null;

/** Highlighted, non-editable code; cheap enough for 200 cells. */
export function StaticCode(props: { source: string; language: "python" | "text"; placeholder?: string }) {
  const pieces = useMemo(() => {
    const out: Piece[] = [];
    if (props.language === "python" && props.source.length <= 40_000) {
      highlightCode(props.source, pythonLanguage.parser.parse(props.source), highlighter,
        (text, className) => out.push({ text, className }), () => out.push(null));
    } else {
      props.source.split("\n").forEach((line, index) => {
        if (index) out.push(null);
        out.push({ text: line, className: "" });
      });
    }
    return out;
  }, [props.source, props.language]);
  return (
    <pre className={`static-code${props.source ? "" : " empty"}`} data-placeholder={props.placeholder ?? ""}>
      {pieces.map((piece, index) => piece === null ? "\n"
        : piece.className ? <span key={index} className={piece.className}>{piece.text}</span> : piece.text)}
    </pre>
  );
}

export type EditorCommands = {
  onChange(value: string): void;
  onRun(advance: boolean): void;
  onEscape(): void;
  onSaveNow(): void;
  onBlur(): void;
};

/** CodeMirror 6 editor mounted only for the cell being edited. */
export function CodeEditor(props: {
  value: string; language: "python" | "text"; label: string; placeholder?: string;
} & EditorCommands) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const commands = useRef<EditorCommands>(props);
  useLayoutEffect(() => { commands.current = props; });

  useEffect(() => {
    if (!host.current) return;
    const run = (advance: boolean) => () => { commands.current.onRun(advance); return true; };
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        history(), drawSelection(), indentOnInput(), bracketMatching(),
        syntaxHighlighting(highlighter),
        ...(props.language === "python" ? [python()] : [EditorView.lineWrapping]),
        placeholder(props.placeholder ?? ""),
        keymap.of([
          { key: "Shift-Enter", run: run(true) },
          { key: "Mod-Enter", run: run(false) },
          { key: "Escape", run: () => { commands.current.onEscape(); return true; } },
          { key: "Mod-s", run: () => { commands.current.onSaveNow(); return true; } },
          indentWithTab, ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) commands.current.onChange(update.state.doc.toString());
          if (update.focusChanged && !update.view.hasFocus) commands.current.onBlur();
        }),
        EditorView.contentAttributes.of({ "aria-label": props.label }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    editor.focus();
    editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    return () => { editor.destroy(); view.current = null; };
    // The editor is created once per mount; later value changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== props.value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.value } });
    }
  }, [props.value]);

  return <div className="cm-host" ref={host} />;
}
