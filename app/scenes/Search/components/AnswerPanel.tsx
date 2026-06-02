import { SparklesIcon } from "outline-icons";
import { Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { basicExtensions } from "@shared/editor/nodes";
import CodeBlock from "@shared/editor/nodes/CodeBlock";
import CodeFence from "@shared/editor/nodes/CodeFence";
import HardBreak from "@shared/editor/nodes/HardBreak";
import { s } from "@shared/styles";
import Editor from "~/components/Editor";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import type Document from "~/models/Document";
import { documentPath } from "~/utils/routeHelpers";

// Read-only rendering of the answer Markdown: the foundational nodes/marks
// (headings, lists, bold, links, …) plus code, without the editing-only and
// document-context extensions (comments, mentions) that the answer never uses.
const extensions = [...basicExtensions, CodeBlock, CodeFence, HardBreak];

interface Props {
  /** The AI-generated answer text (Markdown) to display. */
  answer: string;
  /**
   * The documents the answer cites, indexed by citation number ([1] -> [0]).
   * A hole (undefined) means the cited document is not loaded; its `[n]` marker
   * is then left as plain text rather than linked.
   */
  sources: (Document | undefined)[];
}

/**
 * Rewrite inline `[n]` citation markers into Markdown links to the cited
 * documents, so the editor renders them as clickable links. The brackets are
 * escaped so the visible link text stays `[n]`.
 */
function withCitationLinks(
  answer: string,
  sources: (Document | undefined)[]
): string {
  return answer.replace(/\[(\d+)\]/g, (match, num: string) => {
    const source = sources[parseInt(num, 10) - 1];
    return source ? `[\\[${num}\\]](${documentPath(source)})` : match;
  });
}

/**
 * Displays an AI-generated answer card above search results when available.
 * The answer Markdown is rendered (formatting + clickable `[n]` citations) via
 * a read-only editor. Rendered only when AI search is enabled and the API
 * returns an answer.
 */
export function AnswerPanel({ answer, sources }: Props) {
  const { t } = useTranslation();
  const markdown = useMemo(
    () => withCitationLinks(answer, sources),
    [answer, sources]
  );

  return (
    <Container column>
      <Header align="center" gap={6}>
        <SparklesIcon size={16} aria-hidden />
        <Label type="secondary" size="small" weight="bold">
          {t("AI answers")}
        </Label>
      </Header>
      <Description type="secondary" size="xsmall">
        {t(
          "AI generated answer based on related documents in your workspace"
        )}
      </Description>
      <Body>
        <Suspense fallback={null}>
          {/* Re-mount on a new answer so the read-only editor re-parses it. */}
          <Editor
            key={markdown}
            readOnly
            defaultValue={markdown}
            extensions={extensions}
          />
        </Suspense>
      </Body>
    </Container>
  );
}

const Container = styled(Flex)`
  background: ${s("backgroundSecondary")};
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  gap: 6px;
`;

const Header = styled(Flex)`
  color: ${s("textSecondary")};
`;

const Label = styled(Text)`
  display: block;
`;

const Description = styled(Text)`
  display: block;
  margin-bottom: 6px;
`;

const Body = styled.div`
  font-size: 15px;
  line-height: 1.6;

  // The read-only editor carries document typography; strip its outer spacing
  // and min-height so it sits flush inside the card.
  .ProseMirror {
    padding: 0;
    min-height: auto;
  }
`;
