import { AttachmentPreset } from "@shared/types";
import env from "@server/env";
import AttachmentHelper from "./AttachmentHelper";

describe("AttachmentHelper", () => {
  describe("getKey", () => {
    it("should return the correct key for a private attachment", () => {
      const key = AttachmentHelper.getKey({
        id: "123",
        name: "test.png",
        userId: "456",
      });

      expect(key).toEqual("uploads/456/123/test.png");
    });

    it("should return the correct key for a long file name", () => {
      const key = AttachmentHelper.getKey({
        id: "123",
        name: "a".repeat(300),
        userId: "456",
      });

      expect(key).toEqual(
        `uploads/456/123/${"a".repeat(AttachmentHelper.maximumFileNameLength)}`
      );
    });

    it("should remove invalid characters from the key", () => {
      const key = AttachmentHelper.getKey({
        id: "123",
        name: "test/../one.png",
        userId: "456",
      });

      expect(key).toEqual("uploads/456/123/test/one.png");
    });
  });
});

describe("AttachmentHelper – AISummarySource preset", () => {
  it("uses the AI summary max size", () => {
    expect(AttachmentHelper.presetToMaxUploadSize(AttachmentPreset.AISummarySource)).toEqual(
      env.AI_SUMMARY_MAX_FILE_SIZE
    );
  });

  it("is private", () => {
    expect(AttachmentHelper.presetToAcl(AttachmentPreset.AISummarySource)).toEqual("private");
  });

  it("never expires", () => {
    expect(AttachmentHelper.presetToExpiry(AttachmentPreset.AISummarySource)).toBeUndefined();
  });
});
