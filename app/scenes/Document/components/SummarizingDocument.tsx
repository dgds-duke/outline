import { observer } from "mobx-react";
import { SparklesIcon } from "outline-icons";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import styled, { keyframes } from "styled-components";
import { s } from "@shared/styles";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import type Document from "~/models/Document";

/** How often to re-check whether the summary has finished generating. */
const POLL_INTERVAL_MS = 3000;
/** Stop polling after this long, as a safety valve against a stuck job. */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

type Props = {
  /** The draft that is currently being summarized. */
  document: Document;
};

/**
 * Shown in place of the editor while an AI summary is being generated into a
 * draft. The collaborative editor is intentionally not mounted, so the
 * background task can replace the draft's content without a live editing
 * session clobbering it. Polls the document until the summary lands, at which
 * point `isSummarizing` flips and the parent re-renders the editor.
 */
function SummarizingDocument({ document }: Props) {
  const { t } = useTranslation();
  const { documents } = useStores();

  useEffect(() => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        clearInterval(interval);
        return;
      }
      void documents.fetch(document.id, { force: true });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [documents, document.id]);

  return (
    <Centered align="center" justify="center" column gap={12}>
      <PulsingIcon>
        <SparklesIcon size={32} />
      </PulsingIcon>
      <Text type="secondary">
        {t("Summarizing your paper… this draft will open when it's ready.")}
      </Text>
    </Centered>
  );
}

const pulse = keyframes`
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
`;

const PulsingIcon = styled.div`
  color: ${s("textTertiary")};
  animation: ${pulse} 1.6s ease-in-out infinite;
`;

const Centered = styled(Flex)`
  min-height: 40vh;
  text-align: center;
  color: ${s("textSecondary")};
`;

export default observer(SummarizingDocument);
