import { SparklesIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import Flex from "~/components/Flex";
import Text from "~/components/Text";

interface Props {
  /** The AI-generated answer text to display. */
  answer: string;
}

/**
 * Displays an AI-generated answer card above search results when available.
 * Rendered only when AI search is enabled and the API returns an answer.
 */
export function AnswerPanel({ answer }: Props) {
  const { t } = useTranslation();

  return (
    <Container column>
      <Header align="center" gap={6}>
        <SparklesIcon size={16} />
        <Label type="secondary" size="small" weight="bold">
          {t("AI answers")}
        </Label>
      </Header>
      <Description type="secondary" size="xsmall">
        {t(
          "AI generated answer based on related documents in your workspace"
        )}
      </Description>
      <AnswerText selectable>{answer}</AnswerText>
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
