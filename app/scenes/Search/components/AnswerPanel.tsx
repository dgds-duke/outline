import { SparklesIcon } from "outline-icons";
import { Fragment, type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled from "styled-components";
import { s } from "@shared/styles";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import type Document from "~/models/Document";
import { documentPath } from "~/utils/routeHelpers";

interface Props {
  /** The AI-generated answer text to display. */
  answer: string;
  /**
   * The documents the answer cites, indexed by citation number ([1] -> [0]).
   * A hole (undefined) means the cited document is not loaded; its `[n]` marker
   * is then rendered as plain text rather than a link.
   */
  sources: (Document | undefined)[];
}

/**
 * Displays an AI-generated answer card above search results when available.
 * Inline `[n]` citation markers are rendered as links to the cited documents.
 * Rendered only when AI search is enabled and the API returns an answer.
 */
export function AnswerPanel({ answer, sources }: Props) {
  const { t } = useTranslation();

  // Split the answer on [n] citation markers, linking each to its source.
  const nodes = useMemo<ReactNode[]>(() => {
    const result: ReactNode[] = [];
    const citation = /\[(\d+)\]/g;
    let lastIndex = 0;
    let key = 0;
    let match: RegExpExecArray | null;
    const pushText = (text: string) => {
      if (text) {
        result.push(<Fragment key={`t${key++}`}>{text}</Fragment>);
      }
    };
    while ((match = citation.exec(answer)) !== null) {
      pushText(answer.slice(lastIndex, match.index));
      const number = parseInt(match[1], 10);
      const source = sources[number - 1];
      if (source) {
        result.push(
          <CitationLink
            key={`c${key++}`}
            to={documentPath(source)}
            title={source.title}
            aria-label={t("Open cited source {{ number }}", { number })}
          >
            {match[0]}
          </CitationLink>
        );
      } else {
        pushText(match[0]);
      }
      lastIndex = citation.lastIndex;
    }
    pushText(answer.slice(lastIndex));
    return result;
  }, [answer, sources, t]);

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
      <AnswerText selectable>{nodes}</AnswerText>
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

const AnswerText = styled(Text)`
  display: block;
  white-space: pre-wrap;
  line-height: 1.6;
  font-size: 15px;
`;

const CitationLink = styled(Link)`
  color: ${s("accent")};
  font-weight: 500;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`;
