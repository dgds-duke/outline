import { observer } from "mobx-react";
import { SparklesIcon } from "outline-icons";
import { useCallback, useState } from "react";
import Dropzone from "react-dropzone";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AttachmentPreset } from "@shared/types";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import SidebarLink from "~/components/Sidebar/components/SidebarLink";
import Text from "~/components/Text";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import usePolicy from "~/hooks/usePolicy";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";
import { uploadFile } from "~/utils/files";

function SummarizePaperDialog({ onSubmit }: { onSubmit: () => void }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [isWorking, setWorking] = useState(false);

  const handleFiles = (files: File[]) => {
    if (files.length > 1) {
      toast.error(t("Please choose a single file"));
      return;
    }
    setFile(files[0]);
  };

  const handleRejection = useCallback(() => {
    toast.error(t("File not supported – please upload a valid PDF file"));
  }, [t]);

  const handleStart = async () => {
    if (!file) {
      return;
    }
    setWorking(true);
    try {
      const attachment = await uploadFile(file, {
        name: file.name,
        preset: AttachmentPreset.AISummarySource,
      });
      await client.post("/aiSummary.create", { attachmentId: attachment.id });
      onSubmit();
      toast.message(file.name, {
        description: t(
          "Summarizing your paper. A draft will appear in your drafts and we will notify you when it is ready."
        ),
      });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Flex gap={8} column>
      <Text as="p" type="secondary">
        {t(
          "Upload a PDF and an AI draft summary will be created in your drafts."
        )}
      </Text>
      <Dropzone
        accept="application/pdf"
        multiple={false}
        onDropAccepted={handleFiles}
        onDropRejected={handleRejection}
        disabled={isWorking}
        noKeyboard
      >
        {({ getRootProps, getInputProps }) => (
          <div {...getRootProps()}>
            <input {...getInputProps()} />
            <Button neutral disabled={isWorking}>
              {file ? file.name : t("Choose a PDF")}…
            </Button>
          </div>
        )}
      </Dropzone>
      <Flex justify="flex-end">
        <Button disabled={!file || isWorking} onClick={handleStart}>
          {isWorking ? `${t("Uploading")}…` : t("Summarize")}
        </Button>
      </Flex>
    </Flex>
  );
}

/**
 * Main-sidebar entry for the summarize-a-paper feature. Opens the upload dialog.
 * Hidden for users who cannot create documents.
 */
export const SummarizePaperSidebarLink = observer(() => {
  const { t } = useTranslation();
  const { dialogs } = useStores();
  const team = useCurrentTeam();
  const can = usePolicy(team);

  const handleOpen = useCallback(() => {
    dialogs.openModal({
      title: t("Summarize a paper"),
      content: (
        <SummarizePaperDialog onSubmit={() => dialogs.closeAllModals()} />
      ),
    });
  }, [dialogs, t]);

  if (!can.createDocument) {
    return null;
  }

  return (
    <SidebarLink
      onClick={handleOpen}
      icon={<SparklesIcon />}
      label={t("Summarize a paper")}
    />
  );
});
